// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/*
 * NEXORA Flash Executor v1.0
 *
 * Atomic flash-loan arbitrage: borrow -> N allow-listed swaps -> repay principal + fee -> send surplus.
 * Every check that protects funds is on-chain; the off-chain bot cannot weaken them.
 *
 * Supported flash-liquidity providers (each must be allow-listed by the owner, per address):
 *   1 AAVE_V3      Pool.flashLoanSimple            -> executeOperation        (pool pulls amount+premium)
 *   2 BALANCER_V2  Vault.flashLoan                 -> receiveFlashLoan        (we push amount+fee back)
 *   3 MORPHO_BLUE  Morpho.flashLoan                -> onMorphoFlashLoan       (Morpho pulls amount, fee 0)
 *   4 EULER_V2     EVault.flashLoan                -> onFlashLoan             (we push amount back, fee 0)
 *
 * Supported swap venues (router allow-list):
 *   0 V2           UniswapV2Router02-compatible swapExactTokensForTokens (Uniswap V2, PancakeSwap V2, SushiSwap, QuickSwap)
 *   1 V3_DEADLINE  Uniswap V3 SwapRouter (v1) / PancakeSwap V3 SwapRouter: exactInputSingle with deadline field
 *   2 V3_ROUTER02  Uniswap SwapRouter02 / PancakeSwap SmartRouter: exactInputSingle without deadline field
 *
 * Roles:
 *   owner     cold wallet: allow-lists, caps, operator, profit receiver, unpause, rescue. Set once (not transferable).
 *   operator  hot bot key: may only call start() with allow-listed providers/routers/tokens and may pause.
 *             It cannot redirect profit, change limits, unpause or withdraw funds.
 *
 * Accounting is balance-delta based: router return values are never trusted.
 * Fee-on-transfer / rebasing tokens are NOT supported and must never be allow-listed.
 * THIS CONTRACT HAS NOT BEEN AUDITED BY A THIRD PARTY.
 */

interface IERC20Min {
    function balanceOf(address account) external view returns (uint256);
}

interface IAaveV3PoolMin {
    function flashLoanSimple(address receiverAddress, address asset, uint256 amount, bytes calldata params, uint16 referralCode) external;
}

interface IBalancerVaultMin {
    function flashLoan(address recipient, address[] calldata tokens, uint256[] calldata amounts, bytes calldata userData) external;
}

interface IMorphoMin {
    function flashLoan(address token, uint256 assets, bytes calldata data) external;
}

interface IEulerVaultMin {
    function asset() external view returns (address);
    function flashLoan(uint256 amount, bytes calldata data) external;
}

interface IV2RouterMin {
    function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] calldata path, address to, uint256 deadline)
        external returns (uint256[] memory amounts);
}

interface IV3RouterDeadline {
    struct ExactInputSingleParams {
        address tokenIn; address tokenOut; uint24 fee; address recipient; uint256 deadline;
        uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96;
    }
    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}

interface IV3Router02 {
    struct ExactInputSingleParams {
        address tokenIn; address tokenOut; uint24 fee; address recipient;
        uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96;
    }
    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}

contract NexoraFlashExecutor {
    uint8 public constant AAVE_V3 = 1;
    uint8 public constant BALANCER_V2 = 2;
    uint8 public constant MORPHO_BLUE = 3;
    uint8 public constant EULER_V2 = 4;

    uint8 public constant DEX_V2 = 0;
    uint8 public constant DEX_V3_DEADLINE = 1;
    uint8 public constant DEX_V3_ROUTER02 = 2;

    uint256 public constant MAX_LEGS = 4;
    string public constant VERSION = "1.0.0";

    struct Leg {
        address router;
        uint8 kind;
        address tokenIn;
        address tokenOut;
        uint24 fee;      // V3 pool fee tier; must be 0 for V2
        uint256 minOut;  // per-leg slippage floor, enforced by balance delta
    }

    struct Plan {
        address provider;
        address asset;
        uint256 amount;
        uint256 maxFee;     // reject if the provider charges more than this (fee drift guard)
        uint256 minProfit;  // surplus after full repayment; must be > 0
        uint256 deadline;
        Leg[] legs;
    }

    address public owner;
    address public operator;
    address public profitReceiver;
    bool public paused = true;

    mapping(address => uint8) public providerKind;
    mapping(address => bool) public allowedRouter;
    mapping(address => bool) public allowedToken;
    mapping(address => uint256) public maxLoan;

    // Execution context (only valid while status == ACTIVE).
    uint256 private constant IDLE = 1;
    uint256 private constant ACTIVE = 2;
    uint256 private status = IDLE;
    address private activeProvider;
    bytes32 private activePlanHash;
    uint256 private activeBalanceBefore;
    uint256 private activeFee;
    bool private callbackDone;

    event Executed(address indexed provider, address indexed asset, uint256 amount, uint256 fee, uint256 profit, bytes32 planHash);
    event ProviderSet(address indexed provider, uint8 kind);
    event RouterSet(address indexed router, bool enabled);
    event TokenSet(address indexed token, bool enabled);
    event MaxLoanSet(address indexed asset, uint256 amount);
    event OperatorSet(address indexed newOperator);
    event ProfitReceiverSet(address indexed receiver);
    event Paused(bool isPaused, address indexed by);
    event Rescued(address indexed token, uint256 amount);

    modifier onlyOwner() { require(msg.sender == owner, "owner only"); _; }
    modifier onlyOperator() { require(msg.sender == operator || msg.sender == owner, "operator only"); _; }
    modifier whenIdle() { require(status == IDLE, "busy"); _; }

    constructor(address owner_, address operator_, address profitReceiver_) {
        require(owner_ != address(0) && operator_ != address(0) && profitReceiver_ != address(0), "zero address");
        owner = owner_;
        operator = operator_;
        profitReceiver = profitReceiver_;
        emit OperatorSet(operator_);
        emit ProfitReceiverSet(profitReceiver_);
        emit Paused(true, msg.sender);
    }

    // ------------------------------------------------------------------ admin

    function setProvider(address provider, uint8 kind) external onlyOwner whenIdle {
        require(kind <= EULER_V2, "bad kind");
        if (kind != 0) require(provider.code.length > 0, "not contract");
        providerKind[provider] = kind;
        emit ProviderSet(provider, kind);
    }

    function setRouter(address router, bool enabled) external onlyOwner whenIdle {
        if (enabled) require(router.code.length > 0, "not contract");
        allowedRouter[router] = enabled;
        emit RouterSet(router, enabled);
    }

    function setToken(address token, bool enabled) external onlyOwner whenIdle {
        if (enabled) require(token.code.length > 0, "not contract");
        allowedToken[token] = enabled;
        emit TokenSet(token, enabled);
    }

    function setMaxLoan(address asset, uint256 amount) external onlyOwner whenIdle {
        maxLoan[asset] = amount;
        emit MaxLoanSet(asset, amount);
    }

    function setOperator(address operator_) external onlyOwner whenIdle {
        require(operator_ != address(0), "zero address");
        operator = operator_;
        emit OperatorSet(operator_);
    }

    function setProfitReceiver(address receiver) external onlyOwner whenIdle {
        require(receiver != address(0), "zero address");
        profitReceiver = receiver;
        emit ProfitReceiverSet(receiver);
    }

    /// Emergency stop: owner or operator.
    function pause() external onlyOperator {
        paused = true;
        emit Paused(true, msg.sender);
    }

    /// Only the cold owner can resume.
    function unpause() external onlyOwner whenIdle {
        paused = false;
        emit Paused(false, msg.sender);
    }

    function rescue(address token, uint256 amount) external onlyOwner whenIdle {
        _transfer(token, owner, amount);
        emit Rescued(token, amount);
    }

    function rescueNative(uint256 amount) external onlyOwner whenIdle {
        (bool ok,) = owner.call{value: amount}("");
        require(ok, "native transfer failed");
        emit Rescued(address(0), amount);
    }

    // ------------------------------------------------------------------ execution

    function start(Plan calldata plan) external onlyOperator whenIdle returns (uint256 profit, uint256 fee) {
        require(!paused, "paused");
        _validatePlan(plan);

        status = ACTIVE;
        bytes memory data = abi.encode(plan);
        bytes32 planHash = keccak256(data);
        activeProvider = plan.provider;
        activePlanHash = planHash;
        activeBalanceBefore = IERC20Min(plan.asset).balanceOf(address(this));
        activeFee = 0;
        callbackDone = false;

        uint8 kind = providerKind[plan.provider];
        if (kind == AAVE_V3) {
            IAaveV3PoolMin(plan.provider).flashLoanSimple(address(this), plan.asset, plan.amount, data, 0);
        } else if (kind == BALANCER_V2) {
            address[] memory tokens = new address[](1);
            uint256[] memory amounts = new uint256[](1);
            tokens[0] = plan.asset;
            amounts[0] = plan.amount;
            IBalancerVaultMin(plan.provider).flashLoan(address(this), tokens, amounts, data);
        } else if (kind == MORPHO_BLUE) {
            IMorphoMin(plan.provider).flashLoan(plan.asset, plan.amount, data);
        } else {
            require(IEulerVaultMin(plan.provider).asset() == plan.asset, "euler asset mismatch");
            IEulerVaultMin(plan.provider).flashLoan(plan.amount, data);
        }

        require(callbackDone, "callback not executed");
        // Clear any residual allowance left for pull-based providers.
        if (kind == AAVE_V3 || kind == MORPHO_BLUE) _approve(plan.asset, plan.provider, 0);

        uint256 balanceAfter = IERC20Min(plan.asset).balanceOf(address(this));
        require(balanceAfter >= activeBalanceBefore + plan.minProfit, "repayment left no profit");
        profit = balanceAfter - activeBalanceBefore;
        fee = activeFee;

        activeProvider = address(0);
        activePlanHash = bytes32(0);
        activeBalanceBefore = 0;
        activeFee = 0;
        callbackDone = false;
        status = IDLE;

        _transfer(plan.asset, profitReceiver, profit);
        emit Executed(plan.provider, plan.asset, plan.amount, fee, profit, planHash);
    }

    function _validatePlan(Plan calldata plan) internal view {
        require(providerKind[plan.provider] != 0, "provider not allowed");
        require(allowedToken[plan.asset], "asset not allowed");
        require(plan.amount > 0 && plan.amount <= maxLoan[plan.asset], "loan limit");
        require(block.timestamp <= plan.deadline, "expired");
        require(plan.minProfit > 0, "positive min profit required");
        uint256 n = plan.legs.length;
        require(n >= 2 && n <= MAX_LEGS, "leg count");
        require(plan.legs[0].tokenIn == plan.asset, "route must start with asset");
        require(plan.legs[n - 1].tokenOut == plan.asset, "route must end with asset");
        for (uint256 i = 0; i < n; i++) {
            Leg calldata l = plan.legs[i];
            require(allowedRouter[l.router], "router not allowed");
            require(allowedToken[l.tokenIn] && allowedToken[l.tokenOut], "token not allowed");
            require(l.tokenIn != l.tokenOut, "identical tokens");
            require(l.kind <= DEX_V3_ROUTER02, "bad dex kind");
            if (l.kind == DEX_V2) require(l.fee == 0, "v2 leg has fee tier");
            else require(l.fee > 0, "missing fee tier");
            if (i + 1 < n) require(l.tokenOut == plan.legs[i + 1].tokenIn, "broken path");
        }
    }

    // ------------------------------------------------------------------ provider callbacks

    /// Aave V3
    function executeOperation(address asset, uint256 amount, uint256 premium, address initiator, bytes calldata params)
        external returns (bool)
    {
        _authCallback(AAVE_V3);
        require(initiator == address(this), "bad initiator");
        uint256 owed = _onLoan(asset, amount, premium, params);
        _approve(asset, msg.sender, owed);
        return true;
    }

    /// Balancer V2
    function receiveFlashLoan(address[] calldata tokens, uint256[] calldata amounts, uint256[] calldata feeAmounts, bytes calldata userData)
        external
    {
        _authCallback(BALANCER_V2);
        require(tokens.length == 1 && amounts.length == 1 && feeAmounts.length == 1, "single asset only");
        uint256 owed = _onLoan(tokens[0], amounts[0], feeAmounts[0], userData);
        _transfer(tokens[0], msg.sender, owed);
    }

    /// Morpho Blue
    function onMorphoFlashLoan(uint256 assets, bytes calldata data) external {
        _authCallback(MORPHO_BLUE);
        Plan memory p = abi.decode(data, (Plan));
        uint256 owed = _onLoan(p.asset, assets, 0, data);
        _approve(p.asset, msg.sender, owed);
    }

    /// Euler V2 (EVK vault)
    function onFlashLoan(bytes calldata data) external {
        _authCallback(EULER_V2);
        Plan memory p = abi.decode(data, (Plan));
        uint256 owed = _onLoan(p.asset, p.amount, 0, data);
        _transfer(p.asset, msg.sender, owed);
    }

    function _authCallback(uint8 kind) internal view {
        require(status == ACTIVE, "not in execution");
        require(msg.sender == activeProvider && providerKind[msg.sender] == kind, "unexpected lender");
        require(!callbackDone, "callback replay");
    }

    function _onLoan(address asset, uint256 amount, uint256 fee, bytes calldata data) internal returns (uint256 owed) {
        require(keccak256(data) == activePlanHash, "plan mismatch");
        Plan memory p = abi.decode(data, (Plan));
        require(asset == p.asset && amount == p.amount, "loan mismatch");
        require(fee <= p.maxFee, "lender fee above limit");
        require(block.timestamp <= p.deadline, "expired");
        require(IERC20Min(asset).balanceOf(address(this)) >= activeBalanceBefore + amount, "loan not received");

        uint256 amountIn = amount;
        for (uint256 i = 0; i < p.legs.length; i++) {
            amountIn = _swap(p.legs[i], amountIn, p.deadline);
        }

        owed = amount + fee;
        require(IERC20Min(asset).balanceOf(address(this)) >= activeBalanceBefore + owed + p.minProfit, "insufficient profit");
        activeFee = fee;
        callbackDone = true;
    }

    function _swap(Leg memory l, uint256 amountIn, uint256 deadline) internal returns (uint256 out) {
        uint256 balBefore = IERC20Min(l.tokenOut).balanceOf(address(this));
        _approve(l.tokenIn, l.router, amountIn);
        if (l.kind == DEX_V2) {
            address[] memory path = new address[](2);
            path[0] = l.tokenIn;
            path[1] = l.tokenOut;
            IV2RouterMin(l.router).swapExactTokensForTokens(amountIn, l.minOut, path, address(this), deadline);
        } else if (l.kind == DEX_V3_DEADLINE) {
            IV3RouterDeadline(l.router).exactInputSingle(IV3RouterDeadline.ExactInputSingleParams({
                tokenIn: l.tokenIn, tokenOut: l.tokenOut, fee: l.fee, recipient: address(this), deadline: deadline,
                amountIn: amountIn, amountOutMinimum: l.minOut, sqrtPriceLimitX96: 0
            }));
        } else {
            IV3Router02(l.router).exactInputSingle(IV3Router02.ExactInputSingleParams({
                tokenIn: l.tokenIn, tokenOut: l.tokenOut, fee: l.fee, recipient: address(this),
                amountIn: amountIn, amountOutMinimum: l.minOut, sqrtPriceLimitX96: 0
            }));
        }
        _approve(l.tokenIn, l.router, 0);
        out = IERC20Min(l.tokenOut).balanceOf(address(this)) - balBefore;
        require(out >= l.minOut && out > 0, "slippage");
    }

    // ------------------------------------------------------------------ token helpers (non-standard return tolerant)

    function _approve(address token, address spender, uint256 amount) internal {
        (bool ok, bytes memory out) = token.call(abi.encodeWithSelector(bytes4(0x095ea7b3), spender, 0));
        require(ok && (out.length == 0 || abi.decode(out, (bool))), "approve reset failed");
        if (amount > 0) {
            (ok, out) = token.call(abi.encodeWithSelector(bytes4(0x095ea7b3), spender, amount));
            require(ok && (out.length == 0 || abi.decode(out, (bool))), "approve failed");
        }
    }

    function _transfer(address token, address to, uint256 amount) internal {
        if (amount == 0) return;
        (bool ok, bytes memory out) = token.call(abi.encodeWithSelector(bytes4(0xa9059cbb), to, amount));
        require(ok && (out.length == 0 || abi.decode(out, (bool))), "transfer failed");
    }

    receive() external payable {}
}
