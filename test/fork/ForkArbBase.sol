// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {TestBase} from "../utils/TestBase.sol";
import {NexoraFlashExecutor} from "../../contracts/NexoraFlashExecutor.sol";

interface IERC20F {
    function balanceOf(address) external view returns (uint256);
    function decimals() external view returns (uint8);
    function approve(address, uint256) external returns (bool);
}
interface IWrapped { function deposit() external payable; }
interface IV2Factory { function getPair(address, address) external view returns (address); }
interface IV2Pair { function getReserves() external view returns (uint112, uint112, uint32); function token0() external view returns (address); }
interface IV2Router {
    function getAmountsOut(uint256, address[] calldata) external view returns (uint256[] memory);
    function swapExactTokensForTokens(uint256, uint256, address[] calldata, address, uint256) external returns (uint256[] memory);
}
interface IQuoterV2 {
    struct QuoteExactInputSingleParams { address tokenIn; address tokenOut; uint256 amountIn; uint24 fee; uint160 sqrtPriceLimitX96; }
    function quoteExactInputSingle(QuoteExactInputSingleParams memory) external returns (uint256, uint160, uint32, uint256);
}
interface IAavePoolF {
    struct ReserveDataLegacy {
        uint256 configuration; uint128 liquidityIndex; uint128 currentLiquidityRate; uint128 variableBorrowIndex;
        uint128 currentVariableBorrowRate; uint128 currentStableBorrowRate; uint40 lastUpdateTimestamp; uint16 id;
        address aTokenAddress; address stableDebtTokenAddress; address variableDebtTokenAddress;
        address interestRateStrategyAddress; uint128 accruedToTreasury; uint128 unbacked; uint128 isolationModeTotalDebt;
    }
    function FLASHLOAN_PREMIUM_TOTAL() external view returns (uint128);
    function getReserveData(address) external view returns (ReserveDataLegacy memory);
}
interface IBalancerVaultF { function getProtocolFeesCollector() external view returns (address); }
interface IBalancerFeesF { function getFlashLoanFeePercentage() external view returns (uint256); }

/// Mainnet-fork harness. Uses REAL deployed lenders, routers and quoters. The only artificial step is a large
/// swap that dislocates the real V2 pool (funded with forked native coin via vm.deal) so that a genuine,
/// on-chain arbitrage exists at the fork block. The test then verifies, against real contract state:
///   * quote -> execution consistency (executed output == QuoterV2/getAmountsOut prediction, exactly)
///   * principal + fee repayment to the real lender
///   * net profit delivered to the receiver == predicted output - loan - fee
///   * revert path leaves lender and receiver untouched
abstract contract ForkArbBase is TestBase {
    struct Net {
        string rpcEnv; string rpcDefault; uint256 chainId;
        address stable; address wrapped;
        address aavePool; address balancerVault; address morpho;
        address v2Router; address v2Factory;
        address v3Router; uint8 v3Kind; address quoter;
    }

    address constant OPERATOR = address(0xB0B);
    address constant TREASURY = address(0x7EA5);
    NexoraFlashExecutor internal exe;
    Net internal n;
    uint256 internal loan;
    uint24 internal bestFee;

    function net() internal pure virtual returns (Net memory);

    function setUp() public virtual {
        n = net();
        string memory url = vm.envOr(n.rpcEnv, n.rpcDefault);
        if (bytes(url).length == 0) url = n.rpcDefault; // CI passes empty strings for unset secrets
        // FORK_BLOCK pins a recent block chosen (and recorded) by scripts/run-validation.mjs; 0 = latest.
        uint256 forkBlock = vm.envOr("FORK_BLOCK", uint256(0));
        if (forkBlock > 0) vm.createSelectFork(url, forkBlock);
        else vm.createSelectFork(url);
        assertEq(block.chainid, n.chainId, "fork chain id");
        _requireCode(n.stable, "stable");
        _requireCode(n.wrapped, "wrapped");
        _requireCode(n.aavePool, "aave pool");
        _requireCode(n.v2Router, "v2 router");
        _requireCode(n.v2Factory, "v2 factory");
        _requireCode(n.v3Router, "v3 router");
        _requireCode(n.quoter, "quoter");

        exe = new NexoraFlashExecutor(address(this), OPERATOR, TREASURY);
        exe.setProvider(n.aavePool, 1);
        if (n.balancerVault != address(0) && n.balancerVault.code.length > 0) exe.setProvider(n.balancerVault, 2);
        if (n.morpho != address(0) && n.morpho.code.length > 0) exe.setProvider(n.morpho, 3);
        exe.setRouter(n.v2Router, true);
        exe.setRouter(n.v3Router, true);
        exe.setToken(n.stable, true);
        exe.setToken(n.wrapped, true);

        // $1,000 pilot size, reduced only if the V2 pool is too small to absorb it.
        uint256 unit = 10 ** IERC20F(n.stable).decimals();
        (uint256 rStable,) = _reserves();
        loan = 1000 * unit;
        if (loan > rStable / 50) loan = rStable / 50;
        require(loan >= 10 * unit, "V2 pool too small for a meaningful fork test");
        exe.setMaxLoan(n.stable, loan);
        exe.unpause();
    }

    function _requireCode(address a, string memory what) internal view {
        require(a.code.length > 0, string.concat("no contract code at configured ", what));
    }

    function _reserves() internal view returns (uint256 rStable, uint256 rWrapped) {
        address pair = IV2Factory(n.v2Factory).getPair(n.stable, n.wrapped);
        require(pair != address(0), "V2 stable/wrapped pair missing");
        (uint112 r0, uint112 r1,) = IV2Pair(pair).getReserves();
        if (IV2Pair(pair).token0() == n.stable) { rStable = r0; rWrapped = r1; }
        else { rStable = r1; rWrapped = r0; }
    }

    /// Dump wrapped native into the real V2 pool: wrapped becomes cheap on V2 relative to V3.
    function _dislocate() internal {
        (, uint256 rWrapped) = _reserves();
        uint256 dump = rWrapped / 8;
        vm.deal(address(this), dump + 1 ether);
        IWrapped(n.wrapped).deposit{value: dump}();
        IERC20F(n.wrapped).approve(n.v2Router, dump);
        address[] memory path = new address[](2);
        path[0] = n.wrapped; path[1] = n.stable;
        IV2Router(n.v2Router).swapExactTokensForTokens(dump, 0, path, address(0xDEAD), block.timestamp);
    }

    function _quotes() internal returns (uint256 buyOut, uint256 sellOut, uint24 fee) {
        address[] memory path = new address[](2);
        path[0] = n.stable; path[1] = n.wrapped;
        buyOut = IV2Router(n.v2Router).getAmountsOut(loan, path)[1];
        uint24[4] memory tiers = [uint24(100), 500, 2500, 3000];
        for (uint256 i = 0; i < tiers.length; i++) {
            try IQuoterV2(n.quoter).quoteExactInputSingle(IQuoterV2.QuoteExactInputSingleParams({
                tokenIn: n.wrapped, tokenOut: n.stable, amountIn: buyOut, fee: tiers[i], sqrtPriceLimitX96: 0
            })) returns (uint256 out, uint160, uint32, uint256) {
                if (out > sellOut) { sellOut = out; fee = tiers[i]; }
            } catch {}
        }
        require(sellOut > 0, "no V3 pool quote for wrapped/stable");
    }

    function _plan(address provider, uint256 buyOut, uint256 sellOut, uint24 fee, uint256 minProfit)
        internal view returns (NexoraFlashExecutor.Plan memory p)
    {
        p.provider = provider;
        p.asset = n.stable;
        p.amount = loan;
        p.maxFee = loan / 100;
        p.minProfit = minProfit;
        p.deadline = block.timestamp + 120;
        p.legs = new NexoraFlashExecutor.Leg[](2);
        p.legs[0] = NexoraFlashExecutor.Leg(n.v2Router, 0, n.stable, n.wrapped, 0, buyOut);
        p.legs[1] = NexoraFlashExecutor.Leg(n.v3Router, n.v3Kind, n.wrapped, n.stable, fee, sellOut);
    }

    function _aaveFee() internal view returns (uint256) {
        uint256 bps = IAavePoolF(n.aavePool).FLASHLOAN_PREMIUM_TOTAL();
        return (loan * bps + 5000) / 10000; // WadRayMath.percentMul (half-up)
    }

    function _aaveHolder() internal view returns (address) {
        return IAavePoolF(n.aavePool).getReserveData(n.stable).aTokenAddress;
    }

    function _balancerFee() internal view returns (uint256) {
        uint256 pct = IBalancerFeesF(IBalancerVaultF(n.balancerVault).getProtocolFeesCollector()).getFlashLoanFeePercentage();
        uint256 product = loan * pct;
        return product == 0 ? 0 : (product - 1) / 1e18 + 1; // FixedPoint.mulUp
    }

    /// Full atomic round trip against a real lender; every number is asserted exactly.
    function _roundTrip(address provider, address liquidityHolder, uint256 expectedFee) internal {
        require(IERC20F(n.stable).balanceOf(liquidityHolder) >= loan, "lender lacks liquidity at fork block");
        _dislocate();
        (uint256 buyOut, uint256 sellOut, uint24 fee) = _quotes();
        require(sellOut > loan + expectedFee, "dislocation did not create a profitable route");
        uint256 expectedProfit = sellOut - loan - expectedFee;

        uint256 lenderBefore = IERC20F(n.stable).balanceOf(liquidityHolder);
        uint256 treasuryBefore = IERC20F(n.stable).balanceOf(TREASURY);

        vm.prank(OPERATOR);
        (uint256 profit, uint256 paidFee) = exe.start(_plan(provider, buyOut, sellOut, fee, expectedProfit));

        assertEq(paidFee, expectedFee, "lender fee");
        assertEq(profit, expectedProfit, "quote-to-execution: realized profit == quoted output - loan - fee");
        assertEq(IERC20F(n.stable).balanceOf(TREASURY) - treasuryBefore, profit, "profit delivered to receiver");
        assertGe(IERC20F(n.stable).balanceOf(liquidityHolder), lenderBefore + expectedFee, "lender repaid principal + fee");
        assertEq(IERC20F(n.stable).balanceOf(address(exe)), 0, "executor holds no stable");
        assertEq(IERC20F(n.wrapped).balanceOf(address(exe)), 0, "executor holds no wrapped");
    }

    /// Same route demanding one unit more than achievable must revert and leave all balances unchanged.
    function _revertPath(address provider, address liquidityHolder, uint256 expectedFee) internal {
        _dislocate();
        (uint256 buyOut, uint256 sellOut, uint24 fee) = _quotes();
        require(sellOut > loan + expectedFee, "dislocation did not create a profitable route");
        uint256 lenderBefore = IERC20F(n.stable).balanceOf(liquidityHolder);
        uint256 treasuryBefore = IERC20F(n.stable).balanceOf(TREASURY);
        NexoraFlashExecutor.Plan memory p = _plan(provider, buyOut, sellOut, fee, sellOut - loan - expectedFee + 1);
        vm.prank(OPERATOR);
        vm.expectRevert(bytes("insufficient profit"));
        exe.start(p);
        assertEq(IERC20F(n.stable).balanceOf(liquidityHolder), lenderBefore, "lender unchanged after revert");
        assertEq(IERC20F(n.stable).balanceOf(TREASURY), treasuryBefore, "receiver unchanged after revert");
    }

    function test_aave_roundTrip() public { _roundTrip(n.aavePool, _aaveHolder(), _aaveFee()); }
    function test_aave_revertKeepsLenderWhole() public { _revertPath(n.aavePool, _aaveHolder(), _aaveFee()); }

    function test_aave_naturalMarketHasNoFreeLunch() public {
        // Without the dislocation, the same route should not clear fees: confirms the profit above is caused
        // by the price gap and not by an accounting error. (A real arb at the fork block would also be valid,
        // so this only asserts that a 1-unit floor is enforced consistently with quotes.)
        (uint256 buyOut, uint256 sellOut, uint24 fee) = _quotes();
        uint256 f = _aaveFee();
        NexoraFlashExecutor.Plan memory p = _plan(n.aavePool, buyOut, sellOut, fee, 1);
        if (sellOut <= loan + f) {
            vm.prank(OPERATOR);
            vm.expectRevert();
            exe.start(p);
        } else {
            vm.prank(OPERATOR);
            (uint256 profit,) = exe.start(p);
            assertEq(profit, sellOut - loan - f, "natural arb profit equals quote");
        }
    }
}
