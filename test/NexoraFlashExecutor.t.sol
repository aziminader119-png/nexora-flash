// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {TestBase} from "./utils/TestBase.sol";
import {NexoraFlashExecutor} from "../contracts/NexoraFlashExecutor.sol";
import {
    MockToken, MockAavePool, MockBalancerVault, MockMorpho, MockEulerVault, MockRouter, MockRouter02,
    ReentrantRouter, RogueLender, TamperingPool, MockFeeToken
} from "../contracts/mocks/Mocks.sol";

/// Local-EVM tests: successful and reverted atomic flash-loan arbitrage for every provider type and venue type.
contract NexoraFlashExecutorTest is TestBase {
    address constant OPERATOR = address(0xB0B);
    address constant TREASURY = address(0x7EA5);
    address constant STRANGER = address(0xBAD);
    uint256 constant LOAN = 1000e6;

    NexoraFlashExecutor exe;
    MockToken usd;
    MockToken weth;
    MockToken wbtc;
    MockAavePool aave;
    MockBalancerVault balancer;
    MockMorpho morpho;
    MockEulerVault euler;
    MockRouter cheap;   // sells WETH cheaply (buy leg)
    MockRouter rich;    // buys WETH richly (sell leg)
    MockRouter02 rich02;

    function setUp() public {
        usd = new MockToken("USD Coin", "USDC", 6);
        weth = new MockToken("Wrapped Ether", "WETH", 18);
        wbtc = new MockToken("Wrapped BTC", "WBTC", 8);
        aave = new MockAavePool();
        balancer = new MockBalancerVault();
        morpho = new MockMorpho();
        euler = new MockEulerVault(address(usd));
        cheap = new MockRouter();
        rich = new MockRouter();
        rich02 = new MockRouter02();

        for (uint256 i = 0; i < 4; i++) {
            address lender = [address(aave), address(balancer), address(morpho), address(euler)][i];
            usd.mint(lender, 1_000_000e6);
        }
        weth.mint(address(cheap), 1_000e18);
        wbtc.mint(address(cheap), 1_000e8);
        usd.mint(address(rich), 1_000_000e6);
        usd.mint(address(rich02), 1_000_000e6);

        // 1000 USD buys 0.505 WETH on `cheap`; 0.505 WETH sells for 1010 USD on `rich` => 10 USD gross edge.
        cheap.setRate(address(usd), address(weth), 505_000_000_000, 1000);
        rich.setRate(address(weth), address(usd), 2000e6, 1e18);
        rich02.setRate(address(weth), address(usd), 2000e6, 1e18);
        // three-leg path USD -> WETH -> WBTC -> USD
        cheap.setRate(address(weth), address(wbtc), 4, 1e12);
        rich.setRate(address(wbtc), address(usd), 500, 1);

        exe = new NexoraFlashExecutor(address(this), OPERATOR, TREASURY);
        exe.setProvider(address(aave), 1);
        exe.setProvider(address(balancer), 2);
        exe.setProvider(address(morpho), 3);
        exe.setProvider(address(euler), 4);
        exe.setRouter(address(cheap), true);
        exe.setRouter(address(rich), true);
        exe.setRouter(address(rich02), true);
        exe.setToken(address(usd), true);
        exe.setToken(address(weth), true);
        exe.setToken(address(wbtc), true);
        exe.setMaxLoan(address(usd), LOAN);
        exe.unpause();
    }

    function _leg(address r, uint8 kind, address a, address b, uint24 fee, uint256 minOut)
        internal pure returns (NexoraFlashExecutor.Leg memory)
    {
        return NexoraFlashExecutor.Leg({router: r, kind: kind, tokenIn: a, tokenOut: b, fee: fee, minOut: minOut});
    }

    function _plan(address provider, uint256 minProfit) internal view returns (NexoraFlashExecutor.Plan memory p) {
        p.provider = provider;
        p.asset = address(usd);
        p.amount = LOAN;
        p.maxFee = LOAN / 100;
        p.minProfit = minProfit;
        p.deadline = block.timestamp + 60;
        p.legs = new NexoraFlashExecutor.Leg[](2);
        p.legs[0] = _leg(address(cheap), 0, address(usd), address(weth), 0, 0.505e18);
        p.legs[1] = _leg(address(rich), 0, address(weth), address(usd), 0, 1010e6);
    }

    function _run(NexoraFlashExecutor.Plan memory p) internal returns (uint256 profit, uint256 fee) {
        vm.prank(OPERATOR);
        (profit, fee) = exe.start(p);
    }

    function _assertClean() internal view {
        assertEq(usd.balanceOf(address(exe)), 0, "executor keeps no USD");
        assertEq(weth.balanceOf(address(exe)), 0, "executor keeps no WETH");
        assertEq(usd.allowance(address(exe), address(aave)), 0, "no residual pool allowance");
        assertEq(usd.allowance(address(exe), address(morpho)), 0, "no residual morpho allowance");
        assertEq(usd.allowance(address(exe), address(cheap)), 0, "no residual router allowance");
        assertEq(weth.allowance(address(exe), address(rich)), 0, "no residual router allowance");
    }

    // ------------------------------------------------------------ successful atomic transactions

    function test_AaveV3_borrowSwapRepayProfit() public {
        uint256 poolBefore = usd.balanceOf(address(aave));
        (uint256 profit, uint256 fee) = _run(_plan(address(aave), 1e6));
        assertEq(fee, 500_000, "aave premium 5 bps (percentMul half-up)");
        assertEq(profit, 9_500_000, "net profit = 10 USD edge - 0.5 premium");
        assertEq(usd.balanceOf(address(aave)), poolBefore + fee, "pool repaid principal + premium");
        assertEq(usd.balanceOf(TREASURY), profit, "profit delivered to receiver");
        _assertClean();
    }

    function test_BalancerV2_zeroFee() public {
        uint256 vaultBefore = usd.balanceOf(address(balancer));
        (uint256 profit, uint256 fee) = _run(_plan(address(balancer), 1e6));
        assertEq(fee, 0, "balancer fee");
        assertEq(profit, 10_000_000, "profit");
        assertEq(usd.balanceOf(address(balancer)), vaultBefore, "vault repaid");
        assertEq(usd.balanceOf(TREASURY), profit, "profit delivered");
        _assertClean();
    }

    function test_BalancerV2_withFee() public {
        balancer.setFeeBps(1);
        uint256 vaultBefore = usd.balanceOf(address(balancer));
        (uint256 profit, uint256 fee) = _run(_plan(address(balancer), 1e6));
        assertEq(fee, 100_000, "balancer fee 1 bp");
        assertEq(profit, 9_900_000, "profit");
        assertEq(usd.balanceOf(address(balancer)), vaultBefore + fee, "vault repaid with fee");
        _assertClean();
    }

    function test_MorphoBlue() public {
        uint256 before = usd.balanceOf(address(morpho));
        (uint256 profit, uint256 fee) = _run(_plan(address(morpho), 1e6));
        assertEq(fee, 0, "morpho fee");
        assertEq(profit, 10_000_000, "profit");
        assertEq(usd.balanceOf(address(morpho)), before, "morpho repaid");
        _assertClean();
    }

    function test_EulerV2() public {
        uint256 before = usd.balanceOf(address(euler));
        (uint256 profit,) = _run(_plan(address(euler), 1e6));
        assertEq(profit, 10_000_000, "profit");
        assertEq(usd.balanceOf(address(euler)), before, "euler vault repaid");
        _assertClean();
    }

    function test_V3DeadlineAndRouter02Legs() public {
        NexoraFlashExecutor.Plan memory p = _plan(address(aave), 1e6);
        p.legs[0] = _leg(address(cheap), 1, address(usd), address(weth), 500, 0.505e18);
        p.legs[1] = _leg(address(rich02), 2, address(weth), address(usd), 3000, 1010e6);
        (uint256 profit,) = _run(p);
        assertEq(profit, 9_500_000, "profit via V3 + Router02 legs");
        _assertClean();
    }

    function test_ThreeLegRoute() public {
        NexoraFlashExecutor.Plan memory p = _plan(address(aave), 1e6);
        p.legs = new NexoraFlashExecutor.Leg[](3);
        p.legs[0] = _leg(address(cheap), 0, address(usd), address(weth), 0, 0.505e18);
        p.legs[1] = _leg(address(cheap), 0, address(weth), address(wbtc), 0, 2_020_000);
        p.legs[2] = _leg(address(rich), 0, address(wbtc), address(usd), 0, 1010e6);
        (uint256 profit,) = _run(p);
        assertEq(profit, 9_500_000, "three-leg profit");
        assertEq(wbtc.balanceOf(address(exe)), 0, "no WBTC left");
    }

    function test_PreexistingBalanceIsNotCountedAsProfit() public {
        usd.mint(address(exe), 5e6);
        (uint256 profit,) = _run(_plan(address(aave), 1e6));
        assertEq(profit, 9_500_000, "only the trade surplus is profit");
        assertEq(usd.balanceOf(address(exe)), 5e6, "unrelated balance untouched");
    }

    function test_OwnerMayAlsoExecute() public {
        (uint256 profit,) = exe.start(_plan(address(aave), 1e6));
        assertEq(profit, 9_500_000, "owner execution");
    }

    // ------------------------------------------------------------ reverted transactions (atomicity)

    function test_RevertUnprofitableRouteLeavesStateUnchanged() public {
        rich.setRate(address(weth), address(usd), 1980e6, 1e18); // 0.505 WETH -> 999.9 USD: loss
        NexoraFlashExecutor.Plan memory p = _plan(address(aave), 1e6);
        p.legs[1].minOut = 0;
        uint256 poolBefore = usd.balanceOf(address(aave));
        vm.prank(OPERATOR);
        vm.expectRevert(bytes("insufficient profit"));
        exe.start(p);
        assertEq(usd.balanceOf(address(aave)), poolBefore, "pool unchanged");
        assertEq(usd.balanceOf(TREASURY), 0, "no payout");
    }

    function test_RevertWhenProfitBelowFloor() public {
        vm.prank(OPERATOR);
        vm.expectRevert(bytes("insufficient profit"));
        exe.start(_plan(address(aave), 9_500_001));
    }

    function test_RevertLenderFeeAboveLimit() public {
        aave.setPremium(100); // 1%
        NexoraFlashExecutor.Plan memory p = _plan(address(aave), 1e6);
        p.maxFee = 500_000;
        vm.prank(OPERATOR);
        vm.expectRevert(bytes("lender fee above limit"));
        exe.start(p);
    }

    function test_RevertShortPayingRouter() public {
        rich.setShortPay(100); // delivers 1% less than it reports
        vm.prank(OPERATOR);
        vm.expectRevert(bytes("slippage"));
        exe.start(_plan(address(aave), 1e6));
    }

    function test_RevertRouterSlippage() public {
        NexoraFlashExecutor.Plan memory p = _plan(address(aave), 1e6);
        p.legs[1].minOut = 1011e6;
        vm.prank(OPERATOR);
        vm.expectRevert(bytes("Too little received"));
        exe.start(p);
    }

    function test_RevertPaused() public {
        vm.prank(OPERATOR);
        exe.pause();
        vm.prank(OPERATOR);
        vm.expectRevert(bytes("paused"));
        exe.start(_plan(address(aave), 1e6));
        vm.prank(OPERATOR);
        vm.expectRevert(bytes("owner only"));
        exe.unpause();
        exe.unpause();
        (uint256 profit,) = _run(_plan(address(aave), 1e6));
        assertEq(profit, 9_500_000, "resumes after owner unpause");
    }

    function test_DeployedPaused() public {
        NexoraFlashExecutor fresh = new NexoraFlashExecutor(address(this), OPERATOR, TREASURY);
        assertTrue(fresh.paused(), "new executor starts paused");
    }

    function test_RevertLoanLimit() public {
        NexoraFlashExecutor.Plan memory p = _plan(address(aave), 1e6);
        p.amount = LOAN + 1;
        vm.prank(OPERATOR);
        vm.expectRevert(bytes("loan limit"));
        exe.start(p);
        p.amount = 0;
        vm.prank(OPERATOR);
        vm.expectRevert(bytes("loan limit"));
        exe.start(p);
    }

    function test_RevertExpired() public {
        NexoraFlashExecutor.Plan memory p = _plan(address(aave), 1e6);
        vm.warp(p.deadline + 1);
        vm.prank(OPERATOR);
        vm.expectRevert(bytes("expired"));
        exe.start(p);
    }

    function test_RevertZeroMinProfit() public {
        vm.prank(OPERATOR);
        vm.expectRevert(bytes("positive min profit required"));
        exe.start(_plan(address(aave), 0));
    }

    function test_RevertUnlistedProviderRouterToken() public {
        MockAavePool other = new MockAavePool();
        vm.prank(OPERATOR);
        vm.expectRevert(bytes("provider not allowed"));
        exe.start(_plan(address(other), 1e6));

        MockRouter rogue = new MockRouter();
        NexoraFlashExecutor.Plan memory p = _plan(address(aave), 1e6);
        p.legs[0].router = address(rogue);
        vm.prank(OPERATOR);
        vm.expectRevert(bytes("router not allowed"));
        exe.start(p);

        MockToken junk = new MockToken("J", "J", 18);
        p = _plan(address(aave), 1e6);
        p.legs[0].tokenOut = address(junk);
        p.legs[1].tokenIn = address(junk);
        vm.prank(OPERATOR);
        vm.expectRevert(bytes("token not allowed"));
        exe.start(p);
    }

    function test_RevertMalformedRoutes() public {
        NexoraFlashExecutor.Plan memory p = _plan(address(aave), 1e6);
        p.legs[1].tokenIn = address(wbtc);
        vm.prank(OPERATOR);
        vm.expectRevert(bytes("broken path"));
        exe.start(p);

        p = _plan(address(aave), 1e6);
        p.legs[1].tokenOut = address(weth);
        vm.prank(OPERATOR);
        vm.expectRevert(bytes("route must end with asset"));
        exe.start(p);

        p = _plan(address(aave), 1e6);
        NexoraFlashExecutor.Leg memory only = p.legs[0];
        p.legs = new NexoraFlashExecutor.Leg[](1);
        p.legs[0] = only;
        vm.prank(OPERATOR);
        vm.expectRevert(bytes("leg count"));
        exe.start(p);

        p = _plan(address(aave), 1e6);
        p.legs[0].fee = 500; // V2 leg with fee tier
        vm.prank(OPERATOR);
        vm.expectRevert(bytes("v2 leg has fee tier"));
        exe.start(p);

        p = _plan(address(aave), 1e6);
        p.legs[0].kind = 1; // V3 leg without fee tier
        vm.prank(OPERATOR);
        vm.expectRevert(bytes("missing fee tier"));
        exe.start(p);
    }

    // ------------------------------------------------------------ access control and callback security

    function test_OnlyOperatorCanStart() public {
        NexoraFlashExecutor.Plan memory p = _plan(address(aave), 1e6);
        vm.prank(STRANGER);
        vm.expectRevert(bytes("operator only"));
        exe.start(p);
    }

    function test_OperatorCannotAdminister() public {
        vm.startPrank(OPERATOR);
        vm.expectRevert(bytes("owner only"));
        exe.setProfitReceiver(OPERATOR);
        vm.expectRevert(bytes("owner only"));
        exe.setRouter(address(cheap), false);
        vm.expectRevert(bytes("owner only"));
        exe.setMaxLoan(address(usd), type(uint256).max);
        vm.expectRevert(bytes("owner only"));
        exe.rescue(address(usd), 1);
        vm.expectRevert(bytes("owner only"));
        exe.setOperator(STRANGER);
        vm.stopPrank();
    }

    function test_StrangerCannotPause() public {
        vm.prank(STRANGER);
        vm.expectRevert(bytes("operator only"));
        exe.pause();
    }

    function test_CallbackOutsideExecutionRejected() public {
        RogueLender rogue = new RogueLender();
        vm.expectRevert(bytes("not in execution"));
        rogue.poke(address(exe), "");
        vm.expectRevert(bytes("not in execution"));
        rogue.pokeMorpho(address(exe), "");
        vm.expectRevert(bytes("not in execution"));
        rogue.pokeEuler(address(exe), "");
    }

    function test_ReentrantRouterRejected() public {
        ReentrantRouter bad = new ReentrantRouter(address(exe));
        exe.setRouter(address(bad), true);
        NexoraFlashExecutor.Plan memory p = _plan(address(aave), 1e6);
        p.legs[0].router = address(bad);
        vm.prank(OPERATOR);
        vm.expectRevert(bytes("unexpected lender"));
        exe.start(p);
    }

    function test_TamperedParamsRejected() public {
        TamperingPool tp = new TamperingPool();
        usd.mint(address(tp), 10_000e6);
        exe.setProvider(address(tp), 1);
        vm.prank(OPERATOR);
        vm.expectRevert(bytes("plan mismatch"));
        exe.start(_plan(address(tp), 1e6));
    }

    function test_EulerAssetMismatchRejected() public {
        MockEulerVault wethVault = new MockEulerVault(address(weth));
        exe.setProvider(address(wethVault), 4);
        vm.prank(OPERATOR);
        vm.expectRevert(bytes("euler asset mismatch"));
        exe.start(_plan(address(wethVault), 1e6));
    }

    function test_AdminRequiresContracts() public {
        vm.expectRevert(bytes("not contract"));
        exe.setRouter(address(0x1234), true);
        vm.expectRevert(bytes("not contract"));
        exe.setToken(address(0x1234), true);
        vm.expectRevert(bytes("not contract"));
        exe.setProvider(address(0x1234), 1);
        vm.expectRevert(bytes("bad kind"));
        exe.setProvider(address(aave), 9);
    }

    function test_OwnerRescue() public {
        usd.mint(address(exe), 7e6);
        exe.rescue(address(usd), 7e6);
        assertEq(usd.balanceOf(address(this)), 7e6, "rescued to owner");
    }


    // ------------------------------------------------------------ audit negative tests
    function test_Audit_FeeOnTransferLoanAssetReverts() public {
        MockFeeToken fot = new MockFeeToken();
        MockAavePool pool = new MockAavePool();
        fot.mint(address(pool), 1_000_000e18);
        exe.setProvider(address(pool), 1);
        exe.setToken(address(fot), true);
        exe.setMaxLoan(address(fot), 1000e18);
        cheap.setRate(address(fot), address(weth), 1, 2000);
        rich.setRate(address(weth), address(fot), 2100, 1);
        weth.mint(address(cheap), 1e18);
        fot.mint(address(rich), 1_000_000e18);
        NexoraFlashExecutor.Plan memory p = _plan(address(pool), 1);
        p.asset = address(fot);
        p.amount = 1000e18;
        p.maxFee = 10e18;
        p.legs[0] = _leg(address(cheap), 0, address(fot), address(weth), 0, 0);
        p.legs[1] = _leg(address(rich), 0, address(weth), address(fot), 0, 0);
        vm.prank(OPERATOR);
        vm.expectRevert(bytes("loan not received"));
        exe.start(p);
    }

    function test_Audit_FeeOnTransferIntermediateReverts() public {
        MockFeeToken fot = new MockFeeToken();
        exe.setToken(address(fot), true);
        cheap.setRate(address(usd), address(fot), 1e12, 1);
        rich.setRate(address(fot), address(usd), 1010, 1e12);
        fot.mint(address(cheap), 1_000_000e18);
        NexoraFlashExecutor.Plan memory p = _plan(address(aave), 1e6);
        p.legs[0] = _leg(address(cheap), 0, address(usd), address(fot), 0, 1000e18);
        p.legs[1] = _leg(address(rich), 0, address(fot), address(usd), 0, 0);
        uint256 poolBefore = usd.balanceOf(address(aave));
        vm.prank(OPERATOR);
        vm.expectRevert(bytes("slippage"));
        exe.start(p);
        assertEq(usd.balanceOf(address(aave)), poolBefore, "lender untouched");
    }

    function test_Audit_OperatorCannotRedirectProfitOrDrainBalances() public {
        usd.mint(address(exe), 50e6);
        vm.startPrank(OPERATOR);
        vm.expectRevert(bytes("owner only"));
        exe.setProfitReceiver(OPERATOR);
        vm.expectRevert(bytes("owner only"));
        exe.rescue(address(usd), 50e6);
        vm.expectRevert(bytes("owner only"));
        exe.rescueNative(0);
        vm.expectRevert(bytes("owner only"));
        exe.unpause();
        (uint256 profit,) = exe.start(_plan(address(aave), 1e6));
        vm.stopPrank();
        assertEq(usd.balanceOf(TREASURY), profit, "profit only to owner-set receiver");
        assertEq(usd.balanceOf(OPERATOR), 0, "operator receives nothing");
        assertEq(usd.balanceOf(address(exe)), 50e6, "stray balance untouched");
    }

    // ------------------------------------------------------------ fuzz: accounting invariant

    function testFuzz_ProfitAccounting(uint256 loanSeed, uint256 edgeSeed, uint256 premiumSeed) public {
        uint256 loan = 1e6 + (loanSeed % LOAN);             // 1 .. 1001 USD (capped by maxLoan below)
        if (loan > LOAN) loan = LOAN;
        uint256 edgeBps = edgeSeed % 300;                   // 0 .. 2.99 % edge on sell leg
        uint128 premium = uint128(premiumSeed % 50);        // 0 .. 49 bps
        aave.setPremium(premium);
        rich.setRate(address(weth), address(usd), 2000e6 * (10000 + edgeBps), 1e18 * 10000);
        cheap.setRate(address(usd), address(weth), 1e18, 2000e6);

        uint256 mid = loan * 1e18 / 2000e6;
        uint256 out = mid * (2000e6 * (10000 + edgeBps)) / (1e18 * 10000);
        uint256 fee = (loan * premium + 5000) / 10000;

        NexoraFlashExecutor.Plan memory p = _plan(address(aave), 1);
        p.amount = loan;
        p.legs[0].minOut = 0;
        p.legs[1].minOut = 0;
        uint256 poolBefore = usd.balanceOf(address(aave));
        uint256 treasuryBefore = usd.balanceOf(TREASURY);

        if (out < loan + fee + 1) {
            vm.prank(OPERATOR);
            vm.expectRevert(bytes("insufficient profit"));
            exe.start(p);
            assertEq(usd.balanceOf(address(aave)), poolBefore, "pool unchanged on revert");
        } else {
            (uint256 profit, uint256 paidFee) = _run(p);
            assertEq(paidFee, fee, "fee");
            assertEq(profit, out - loan - fee, "profit exact");
            assertEq(usd.balanceOf(address(aave)), poolBefore + fee, "pool +fee");
            assertEq(usd.balanceOf(TREASURY), treasuryBefore + profit, "treasury +profit");
            assertEq(usd.balanceOf(address(exe)), 0, "no residue");
        }
    }
}
