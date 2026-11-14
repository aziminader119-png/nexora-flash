// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

// Test-only mocks. They model the external interfaces the executor depends on and are NEVER deployed to mainnet.

contract MockToken {
    string public name;
    string public symbol;
    uint8 public decimals;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor(string memory n, string memory s, uint8 d) { name = n; symbol = s; decimals = d; }

    function mint(address a, uint256 n) external { balanceOf[a] += n; }
    function approve(address s, uint256 n) external returns (bool) { allowance[msg.sender][s] = n; return true; }
    function transfer(address to, uint256 n) external returns (bool) {
        require(balanceOf[msg.sender] >= n, "balance");
        balanceOf[msg.sender] -= n; balanceOf[to] += n; return true;
    }
    function transferFrom(address from, address to, uint256 n) external returns (bool) {
        require(balanceOf[from] >= n, "balance");
        require(allowance[from][msg.sender] >= n, "allowance");
        allowance[from][msg.sender] -= n; balanceOf[from] -= n; balanceOf[to] += n; return true;
    }
}

interface IAaveReceiver {
    function executeOperation(address asset, uint256 amount, uint256 premium, address initiator, bytes calldata params) external returns (bool);
}
interface IBalancerRecipient {
    function receiveFlashLoan(address[] calldata tokens, uint256[] calldata amounts, uint256[] calldata fees, bytes calldata userData) external;
}
interface IMorphoCallback { function onMorphoFlashLoan(uint256 assets, bytes calldata data) external; }
interface IEulerCallback { function onFlashLoan(bytes calldata data) external; }

/// Aave V3 Pool semantics: transfer, callback, pull amount + premium (percentMul, half-up rounding).
contract MockAavePool {
    uint128 public FLASHLOAN_PREMIUM_TOTAL = 5;
    function setPremium(uint128 bps) external { FLASHLOAN_PREMIUM_TOTAL = bps; }
    // Reserve views used by the off-chain scanner: active (bit 56) + flash loans enabled (bit 63); liquidity held here.
    function getConfiguration(address) external pure returns (uint256) { return (uint256(1) << 56) | (uint256(1) << 63); }
    function getReserveAToken(address) external view returns (address) { return address(this); }
    function flashLoanSimple(address receiver, address asset, uint256 amount, bytes calldata params, uint16) external {
        uint256 premium = (amount * FLASHLOAN_PREMIUM_TOTAL + 5000) / 10000;
        uint256 pre = MockToken(asset).balanceOf(address(this));
        require(pre >= amount, "pool liquidity");
        require(MockToken(asset).transfer(receiver, amount), "send");
        require(IAaveReceiver(receiver).executeOperation(asset, amount, premium, msg.sender, params), "callback");
        require(MockToken(asset).transferFrom(receiver, address(this), amount + premium), "repay");
        require(MockToken(asset).balanceOf(address(this)) >= pre + premium, "pool loss");
    }
}

/// Balancer V2 Vault semantics: transfer, callback, verify balance >= pre + fee.
contract MockBalancerVault {
    uint256 public feeBps;
    function setFeeBps(uint256 b) external { feeBps = b; }
    function flashLoan(address recipient, address[] calldata tokens, uint256[] calldata amounts, bytes calldata userData) external {
        uint256[] memory fees = new uint256[](tokens.length);
        uint256[] memory pre = new uint256[](tokens.length);
        for (uint256 i = 0; i < tokens.length; i++) {
            pre[i] = MockToken(tokens[i]).balanceOf(address(this));
            require(pre[i] >= amounts[i], "vault liquidity");
            fees[i] = (amounts[i] * feeBps + 9999) / 10000;
            require(MockToken(tokens[i]).transfer(recipient, amounts[i]), "send");
        }
        IBalancerRecipient(recipient).receiveFlashLoan(tokens, amounts, fees, userData);
        for (uint256 i = 0; i < tokens.length; i++) {
            require(MockToken(tokens[i]).balanceOf(address(this)) >= pre[i] + fees[i], "BAL#602 INSUFFICIENT_FLASH_LOAN_FEE_AMOUNT");
        }
    }
}

/// Morpho Blue semantics: transfer, callback, transferFrom(assets). Zero fee.
contract MockMorpho {
    function flashLoan(address token, uint256 assets, bytes calldata data) external {
        require(MockToken(token).transfer(msg.sender, assets), "send");
        IMorphoCallback(msg.sender).onMorphoFlashLoan(assets, data);
        require(MockToken(token).transferFrom(msg.sender, address(this), assets), "repay");
    }
}

/// Euler V2 EVault semantics: transfer to caller, callback, balance must be restored. Zero fee.
contract MockEulerVault {
    address public asset;
    constructor(address a) { asset = a; }
    function flashLoan(uint256 amount, bytes calldata data) external {
        uint256 orig = MockToken(asset).balanceOf(address(this));
        require(MockToken(asset).transfer(msg.sender, amount), "send");
        IEulerCallback(msg.sender).onFlashLoan(data);
        require(MockToken(asset).balanceOf(address(this)) >= orig, "E_FlashLoanNotRepaid");
    }
}

/// Fixed-rate router implementing V2 swap + getAmountsOut, V3 (deadline) and V3 Router02 single-hop swaps.
/// Rate is tokenOut per tokenIn as num/den, per direction.
contract MockRouter {
    mapping(address => mapping(address => uint256)) public num;
    mapping(address => mapping(address => uint256)) public den;
    uint256 public shortPayBps; // >0 makes the router deliver less than it reports (malicious venue)

    struct V3Params { address tokenIn; address tokenOut; uint24 fee; address recipient; uint256 deadline; uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96; }

    function setRate(address a, address b, uint256 n, uint256 d) external { num[a][b] = n; den[a][b] = d; }
    function setShortPay(uint256 bps) external { shortPayBps = bps; }

    function quote(address a, address b, uint256 amountIn) public view returns (uint256) {
        require(den[a][b] > 0, "no rate");
        return amountIn * num[a][b] / den[a][b];
    }

    function getAmountsOut(uint256 amountIn, address[] calldata path) external view returns (uint256[] memory amounts) {
        require(path.length == 2, "path");
        amounts = new uint256[](2);
        amounts[0] = amountIn;
        amounts[1] = quote(path[0], path[1], amountIn);
    }

    function _swap(address a, address b, uint256 amountIn, uint256 minOut, address to) internal returns (uint256 out) {
        out = quote(a, b, amountIn);
        require(out >= minOut, "Too little received");
        require(MockToken(a).transferFrom(msg.sender, address(this), amountIn), "in");
        uint256 delivered = out - out * shortPayBps / 10000;
        require(MockToken(b).transfer(to, delivered), "out");
    }

    function swapExactTokensForTokens(uint256 amountIn, uint256 minOut, address[] calldata path, address to, uint256 deadline)
        external returns (uint256[] memory amounts)
    {
        require(block.timestamp <= deadline, "UniswapV2Router: EXPIRED");
        require(path.length == 2, "path");
        amounts = new uint256[](2);
        amounts[0] = amountIn;
        amounts[1] = _swap(path[0], path[1], amountIn, minOut, to);
    }

    function exactInputSingle(V3Params calldata p) external payable returns (uint256) {
        require(block.timestamp <= p.deadline, "Transaction too old");
        require(p.fee > 0, "fee");
        return _swap(p.tokenIn, p.tokenOut, p.amountIn, p.amountOutMinimum, p.recipient);
    }
}

/// Router02-only variant (no deadline in the struct), to verify the V3_ROUTER02 encoding.
contract MockRouter02 {
    struct V3Params02 { address tokenIn; address tokenOut; uint24 fee; address recipient; uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96; }
    mapping(address => mapping(address => uint256)) public num;
    mapping(address => mapping(address => uint256)) public den;
    function setRate(address a, address b, uint256 n, uint256 d) external { num[a][b] = n; den[a][b] = d; }
    function exactInputSingle(V3Params02 calldata p) external payable returns (uint256 out) {
        require(den[p.tokenIn][p.tokenOut] > 0, "no rate");
        out = p.amountIn * num[p.tokenIn][p.tokenOut] / den[p.tokenIn][p.tokenOut];
        require(out >= p.amountOutMinimum, "Too little received");
        require(MockToken(p.tokenIn).transferFrom(msg.sender, address(this), p.amountIn), "in");
        require(MockToken(p.tokenOut).transfer(p.recipient, out), "out");
    }
}

/// QuoterV2-compatible quoter backed by a MockRouter or MockRouter02 rate table.
interface IRateSource { function num(address, address) external view returns (uint256); function den(address, address) external view returns (uint256); }
contract MockQuoterV2 {
    struct QuoteExactInputSingleParams { address tokenIn; address tokenOut; uint256 amountIn; uint24 fee; uint160 sqrtPriceLimitX96; }
    IRateSource public immutable source;
    constructor(address s) { source = IRateSource(s); }
    function quoteExactInputSingle(QuoteExactInputSingleParams memory p)
        external view returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)
    {
        uint256 d = source.den(p.tokenIn, p.tokenOut);
        require(d > 0, "no pool");
        amountOut = p.amountIn * source.num(p.tokenIn, p.tokenOut) / d;
        return (amountOut, 0, 0, 90000);
    }
}

interface IExecutorAttack {
    function executeOperation(address, uint256, uint256, address, bytes calldata) external returns (bool);
    function onMorphoFlashLoan(uint256, bytes calldata) external;
    function onFlashLoan(bytes calldata) external;
    function receiveFlashLoan(address[] calldata, uint256[] calldata, uint256[] calldata, bytes calldata) external;
    function rescue(address, uint256) external;
    function pause() external;
}

/// Router that tries to re-enter the executor's callbacks during a swap (must fail closed).
contract ReentrantRouter {
    address public target;
    bytes public lastError;
    constructor(address t) { target = t; }
    function swapExactTokensForTokens(uint256, uint256, address[] calldata, address, uint256) external returns (uint256[] memory) {
        IExecutorAttack(target).executeOperation(address(0), 1, 0, target, "");
        revert("reentry was not blocked");
    }
}

/// Lender that calls the executor callback without having been asked by start().
contract RogueLender {
    function poke(address executor, bytes calldata data) external {
        IExecutorAttack(executor).executeOperation(address(0), 1, 0, executor, data);
    }
    function pokeMorpho(address executor, bytes calldata data) external { IExecutorAttack(executor).onMorphoFlashLoan(1, data); }
    function pokeEuler(address executor, bytes calldata data) external { IExecutorAttack(executor).onFlashLoan(data); }
}

/// Aave-like pool that charges more premium than the plan allows / tampers with params.
contract TamperingPool {
    function flashLoanSimple(address receiver, address asset, uint256 amount, bytes calldata params, uint16) external {
        require(MockToken(asset).transfer(receiver, amount), "send");
        bytes memory tampered = bytes.concat(params, hex"00");
        IAaveReceiver(receiver).executeOperation(asset, amount, 0, msg.sender, tampered);
    }
}

/** Fee-on-transfer token, burns 1% on transfers. For negative security tests only. */
contract MockFeeToken {
    string public name = "Fee Token";
    string public symbol = "FOT";
    uint8 public decimals = 18;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address a, uint256 n) external { balanceOf[a] += n; }
    function approve(address s, uint256 n) external returns (bool) { allowance[msg.sender][s] = n; return true; }
    function _move(address from, address to, uint256 n) internal {
        require(balanceOf[from] >= n, "balance");
        balanceOf[from] -= n;
        balanceOf[to] += n - n / 100;
    }
    function transfer(address to, uint256 n) external returns (bool) { _move(msg.sender, to, n); return true; }
    function transferFrom(address from, address to, uint256 n) external returns (bool) {
        require(allowance[from][msg.sender] >= n, "allowance");
        allowance[from][msg.sender] -= n;
        _move(from, to, n);
        return true;
    }
}
