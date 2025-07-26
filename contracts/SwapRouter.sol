// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity =0.7.6;
pragma abicoder v2;

import '@uniswap/v3-core/contracts/libraries/SafeCast.sol';
import '@uniswap/v3-core/contracts/libraries/TickMath.sol';
import '@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol';
import '@openzeppelin/contracts/access/Ownable.sol';
import '@openzeppelin/contracts/utils/ReentrancyGuard.sol';

import './interfaces/ISwapRouter.sol';
import './base/PeripheryImmutableState.sol';
import './base/PeripheryValidation.sol';
import './base/PeripheryPaymentsWithFee.sol';
import './base/Multicall.sol';
import './base/SelfPermit.sol';
import './libraries/Path.sol';
import './libraries/PoolAddress.sol';
import './libraries/CallbackValidation.sol';
import './interfaces/external/IWETH9.sol';

/// @title Uniswap V3 Swap Router
/// @notice Router for stateless execution of swaps against Uniswap V3
contract SwapRouter is
    ISwapRouter,
    PeripheryImmutableState,
    PeripheryValidation,
    PeripheryPaymentsWithFee,
    Multicall,
    SelfPermit,
    Ownable,
    ReentrancyGuard
{
    using Path for bytes;
    using SafeCast for uint256;

    /// @dev Used as the placeholder value for amountInCached, because the computed amount in for an exact output swap
    /// can never actually be this value
    uint256 private constant DEFAULT_AMOUNT_IN_CACHED = type(uint256).max;

    /// @dev Transient storage variable used for returning the computed amount in for an exact output swap.
    uint256 private amountInCached = DEFAULT_AMOUNT_IN_CACHED;

    // Referrer configuration
    /// @notice Current referrer address for all swaps
    /// @dev Set to address(0) to disable referrer fees
    address public referrer;
    
    /// @notice Referrer fee in basis points (1 = 0.01%, 100 = 1%)
    /// @dev Maximum value enforced by MAX_REFERRER_FEE constant
    uint24 public referrerFeeBasisPoints;
    
    /// @notice Maximum referrer fee rate (5%)
    uint24 public constant MAX_REFERRER_FEE = 500;

    /// @notice Accumulated referrer fees by referrer address and token
    /// @dev referrer => token => amount
    mapping(address => mapping(address => uint256)) public override referrerFees;

    // Events
    /// @notice Emitted when referrer address changes
    /// @param oldReferrer Previous referrer address
    /// @param newReferrer New referrer address
    event ReferrerChanged(address indexed oldReferrer, address indexed newReferrer);
    
    /// @notice Emitted when referrer fee rate changes
    /// @param oldFee Previous fee in basis points
    /// @param newFee New fee in basis points
    event ReferrerFeeChanged(uint24 oldFee, uint24 newFee);
    
    /// @notice Emitted when referrer fees are accumulated during swap
    /// @param referrer Address that will receive the fee
    /// @param token Token address of the fee
    /// @param amount Fee amount accumulated
    event ReferrerFeeAccumulated(address indexed referrer, address indexed token, uint256 amount);
    
    /// @notice Emitted when referrer fees are collected
    /// @param referrer Address collecting the fees
    /// @param token Token address of the collected fees
    /// @param amount Amount collected
    event ReferrerFeesCollected(address indexed referrer, address indexed token, uint256 amount);

    constructor(address _factory, address _WETH9) PeripheryImmutableState(_factory, _WETH9) {}

    /// @notice Sets the referrer address
    /// @dev Only owner can modify referrer
    /// @param _referrer New referrer address (address(0) disables fees)
    function setReferrer(address _referrer) external override onlyOwner {
        address oldReferrer = referrer;
        referrer = _referrer;
        emit ReferrerChanged(oldReferrer, _referrer);
    }

    /// @notice Sets the referrer fee rate
    /// @dev Only owner can modify fee rate
    /// @param _feeBasisPoints Fee in basis points (max MAX_REFERRER_FEE)
    function setReferrerFee(uint24 _feeBasisPoints) external override onlyOwner {
        require(_feeBasisPoints <= MAX_REFERRER_FEE, 'Fee too high');
        uint24 oldFee = referrerFeeBasisPoints;
        referrerFeeBasisPoints = _feeBasisPoints;
        emit ReferrerFeeChanged(oldFee, _feeBasisPoints);
    }

    /// @notice Returns current referrer configuration
    /// @return referrerAddress Current referrer address
    /// @return feeBasisPoints Current fee in basis points
    function getReferrerConfig() external view override returns (address referrerAddress, uint24 feeBasisPoints) {
        return (referrer, referrerFeeBasisPoints);
    }

    /// @notice Calculate referrer fee for given amount
    /// @param amount Input amount
    /// @return fee Referrer fee amount
    function calculateReferrerFee(uint256 amount) external view override returns (uint256 fee) {
        if (referrer == address(0) || referrerFeeBasisPoints == 0) {
            return 0;
        }
        return (amount * referrerFeeBasisPoints) / 10000;
    }

    /// @notice Collect accumulated referrer fees for a specific token
    /// @param token Token address to collect fees for
    /// @return amount Amount of fees collected
    function collectReferrerFees(address token) external override nonReentrant returns (uint256 amount) {
        amount = referrerFees[msg.sender][token];
        require(amount > 0, 'No fees to collect');
        
        // Clear the accumulated fees before transfer (CEI pattern)
        referrerFees[msg.sender][token] = 0;
        
        // Transfer the fees to the referrer
        pay(token, address(this), msg.sender, amount);
        
        emit ReferrerFeesCollected(msg.sender, token, amount);
    }

    /// @notice Collect accumulated referrer fees for multiple tokens
    /// @param tokens Array of token addresses to collect fees for
    /// @return amounts Array of amounts collected for each token
    function collectReferrerFeesMultiple(address[] calldata tokens) 
        external 
        override
        nonReentrant 
        returns (uint256[] memory amounts) 
    {
        amounts = new uint256[](tokens.length);
        
        for (uint256 i = 0; i < tokens.length; i++) {
            address token = tokens[i];
            uint256 amount = referrerFees[msg.sender][token];
            
            if (amount > 0) {
                // Clear the accumulated fees before transfer (CEI pattern)
                referrerFees[msg.sender][token] = 0;
                
                // Transfer the fees to the referrer
                pay(token, address(this), msg.sender, amount);
                
                emit ReferrerFeesCollected(msg.sender, token, amount);
            }
            
            amounts[i] = amount;
        }
    }

    /// @dev Calculates and accumulates referrer fee from input amount
    /// @param amountIn Original input amount
    /// @param tokenIn Input token address for fee accumulation
    /// @return adjustedAmountIn Amount after referrer fee deduction
    function _processReferrerFee(uint256 amountIn, address tokenIn) 
        private 
        returns (uint256 adjustedAmountIn) 
    {
        // Skip if referrer disabled or no fee set
        if (referrer == address(0) || referrerFeeBasisPoints == 0) {
            return amountIn;
        }
        
        // Calculate referrer fee
        uint256 referrerFee = (amountIn * referrerFeeBasisPoints) / 10000;
        
        if (referrerFee > 0) {
            // Accumulate fee for later collection (safe - no external calls)
            referrerFees[referrer][tokenIn] += referrerFee;
            emit ReferrerFeeAccumulated(referrer, tokenIn, referrerFee);
            
            // Return adjusted amount for swap
            return amountIn - referrerFee;
        }
        
        return amountIn;
    }

    /// @dev Calculate referrer fee without transferring
    function _calculateReferrerFee(uint256 amount) 
        private 
        view 
        returns (uint256) 
    {
        if (referrer == address(0) || referrerFeeBasisPoints == 0) {
            return 0;
        }
        return (amount * referrerFeeBasisPoints) / 10000;
    }

    /// @dev Adjusts minimum output amount to account for referrer fee impact
    function _adjustMinimumForFee(uint256 originalMinimum, uint256 originalAmountIn, uint256 adjustedAmountIn) 
        private 
        pure 
        returns (uint256) 
    {
        if (adjustedAmountIn == originalAmountIn) return originalMinimum;
        
        // Proportionally reduce minimum output expectation
        return (originalMinimum * adjustedAmountIn) / originalAmountIn;
    }

    /// @dev Returns the pool for the given token pair and fee. The pool contract may or may not exist.
    function getPool(
        address tokenA,
        address tokenB,
        uint24 fee
    ) private view returns (IUniswapV3Pool) {
        return IUniswapV3Pool(PoolAddress.computeAddress(factory, PoolAddress.getPoolKey(tokenA, tokenB, fee)));
    }

    struct SwapCallbackData {
        bytes path;
        address payer;
    }

    /// @inheritdoc IUniswapV3SwapCallback
    function uniswapV3SwapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata _data
    ) external override {
        require(amount0Delta > 0 || amount1Delta > 0); // swaps entirely within 0-liquidity regions are not supported
        SwapCallbackData memory data = abi.decode(_data, (SwapCallbackData));
        (address tokenIn, address tokenOut, uint24 fee) = data.path.decodeFirstPool();
        CallbackValidation.verifyCallback(factory, tokenIn, tokenOut, fee);

        (bool isExactInput, uint256 amountToPay) =
            amount0Delta > 0
                ? (tokenIn < tokenOut, uint256(amount0Delta))
                : (tokenOut < tokenIn, uint256(amount1Delta));
        if (isExactInput) {
            pay(tokenIn, data.payer, msg.sender, amountToPay);
        } else {
            // either initiate the next swap or pay
            if (data.path.hasMultiplePools()) {
                data.path = data.path.skipToken();
                exactOutputInternal(amountToPay, msg.sender, 0, data);
            } else {
                amountInCached = amountToPay;
                tokenIn = tokenOut; // swap in/out because exact output swaps are reversed
                pay(tokenIn, data.payer, msg.sender, amountToPay);
            }
        }
    }

    /// @dev Performs a single exact input swap
    function exactInputInternal(
        uint256 amountIn,
        address recipient,
        uint160 sqrtPriceLimitX96,
        SwapCallbackData memory data
    ) private returns (uint256 amountOut) {
        // allow swapping to the router address with address 0
        if (recipient == address(0)) recipient = address(this);

        (address tokenIn, address tokenOut, uint24 fee) = data.path.decodeFirstPool();

        bool zeroForOne = tokenIn < tokenOut;

        (int256 amount0, int256 amount1) =
            getPool(tokenIn, tokenOut, fee).swap(
                recipient,
                zeroForOne,
                amountIn.toInt256(),
                sqrtPriceLimitX96 == 0
                    ? (zeroForOne ? TickMath.MIN_SQRT_RATIO + 1 : TickMath.MAX_SQRT_RATIO - 1)
                    : sqrtPriceLimitX96,
                abi.encode(data)
            );

        return uint256(-(zeroForOne ? amount1 : amount0));
    }

    /// @inheritdoc ISwapRouter
    function exactInputSingle(ExactInputSingleParams calldata params)
        external
        payable
        override
        checkDeadline(params.deadline)
        returns (uint256 amountOut)
    {
        // Process referrer fee and get adjusted input amount
        uint256 adjustedAmountIn = _processReferrerFee(params.amountIn, params.tokenIn);
        
        // Perform swap with adjusted amount
        amountOut = exactInputInternal(
            adjustedAmountIn,
            params.recipient,
            params.sqrtPriceLimitX96,
            SwapCallbackData({path: abi.encodePacked(params.tokenIn, params.fee, params.tokenOut), payer: msg.sender})
        );
        
        // Apply referrer fee impact to minimum output check
        uint256 adjustedMinimum = _adjustMinimumForFee(params.amountOutMinimum, params.amountIn, adjustedAmountIn);
        require(amountOut >= adjustedMinimum, 'Too little received');
    }

    /// @inheritdoc ISwapRouter
    function exactInput(ExactInputParams memory params)
        external
        payable
        override
        checkDeadline(params.deadline)
        returns (uint256 amountOut)
    {
        // Get first token from path for referrer fee calculation
        (address tokenIn, , ) = params.path.decodeFirstPool();
        
        // Store original amount for minimum output adjustment
        uint256 originalAmountIn = params.amountIn;
        
        // Process referrer fee on initial input amount
        uint256 adjustedAmountIn = _processReferrerFee(params.amountIn, tokenIn);
        params.amountIn = adjustedAmountIn;
        
        // Execute multi-hop swap with adjusted amount
        address payer = msg.sender; // msg.sender pays for the first hop

        while (true) {
            bool hasMultiplePools = params.path.hasMultiplePools();

            // the outputs of prior swaps become the inputs to subsequent ones
            params.amountIn = exactInputInternal(
                params.amountIn,
                hasMultiplePools ? address(this) : params.recipient, // for intermediate swaps, this contract custodies
                0,
                SwapCallbackData({
                    path: params.path.getFirstPool(), // only the first pool in the path is necessary
                    payer: payer
                })
            );

            // decide whether to continue or terminate
            if (hasMultiplePools) {
                payer = address(this); // at this point, the caller has paid
                params.path = params.path.skipToken();
            } else {
                amountOut = params.amountIn;
                break;
            }
        }

        // Adjust minimum output check for referrer fee impact
        uint256 adjustedMinimum = _adjustMinimumForFee(params.amountOutMinimum, originalAmountIn, adjustedAmountIn);
        require(amountOut >= adjustedMinimum, 'Too little received');
    }

    /// @dev Performs a single exact output swap
    function exactOutputInternal(
        uint256 amountOut,
        address recipient,
        uint160 sqrtPriceLimitX96,
        SwapCallbackData memory data
    ) private returns (uint256 amountIn) {
        // allow swapping to the router address with address 0
        if (recipient == address(0)) recipient = address(this);

        (address tokenOut, address tokenIn, uint24 fee) = data.path.decodeFirstPool();

        bool zeroForOne = tokenIn < tokenOut;

        (int256 amount0Delta, int256 amount1Delta) =
            getPool(tokenIn, tokenOut, fee).swap(
                recipient,
                zeroForOne,
                -amountOut.toInt256(),
                sqrtPriceLimitX96 == 0
                    ? (zeroForOne ? TickMath.MIN_SQRT_RATIO + 1 : TickMath.MAX_SQRT_RATIO - 1)
                    : sqrtPriceLimitX96,
                abi.encode(data)
            );

        uint256 amountOutReceived;
        (amountIn, amountOutReceived) = zeroForOne
            ? (uint256(amount0Delta), uint256(-amount1Delta))
            : (uint256(amount1Delta), uint256(-amount0Delta));
        // it's technically possible to not receive the full output amount,
        // so if no price limit has been specified, require this possibility away
        if (sqrtPriceLimitX96 == 0) require(amountOutReceived == amountOut);
    }

    /// @inheritdoc ISwapRouter
    function exactOutputSingle(ExactOutputSingleParams calldata params)
        external
        payable
        override
        checkDeadline(params.deadline)
        returns (uint256 amountIn)
    {
        // Perform exact output swap first to determine required input
        amountIn = exactOutputInternal(
            params.amountOut,
            params.recipient,
            params.sqrtPriceLimitX96,
            SwapCallbackData({path: abi.encodePacked(params.tokenOut, params.fee, params.tokenIn), payer: msg.sender})
        );
        
        // Calculate and accumulate referrer fee
        uint256 referrerFee = _calculateReferrerFee(amountIn);
        if (referrerFee > 0 && referrer != address(0)) {
            // Accumulate referrer fee (safe - no external calls)
            referrerFees[referrer][params.tokenIn] += referrerFee;
            emit ReferrerFeeAccumulated(referrer, params.tokenIn, referrerFee);
        }
        
        // Add referrer fee to total amount user must pay
        uint256 totalAmountIn = amountIn + referrerFee;
        require(totalAmountIn <= params.amountInMaximum, 'Too much requested');
        
        // Reset cache
        amountInCached = DEFAULT_AMOUNT_IN_CACHED;
        
        // Return total amount including referrer fee
        return totalAmountIn;
    }

    /// @inheritdoc ISwapRouter
    function exactOutput(ExactOutputParams calldata params)
        external
        payable
        override
        checkDeadline(params.deadline)
        returns (uint256 amountIn)
    {
        // it's okay that the payer is fixed to msg.sender here, as they're only paying for the "final" exact output
        // swap, which happens first, and subsequent swaps are paid for within nested callback frames
        exactOutputInternal(
            params.amountOut,
            params.recipient,
            0,
            SwapCallbackData({path: params.path, payer: msg.sender})
        );

        amountIn = amountInCached;
        
        // Get first token from path for referrer fee calculation
        (address tokenOut, address tokenIn, ) = params.path.decodeFirstPool();
        
        // Calculate and accumulate referrer fee
        uint256 referrerFee = _calculateReferrerFee(amountIn);
        if (referrerFee > 0 && referrer != address(0)) {
            // Accumulate referrer fee (safe - no external calls)
            referrerFees[referrer][tokenIn] += referrerFee;
            emit ReferrerFeeAccumulated(referrer, tokenIn, referrerFee);
        }
        
        // Add referrer fee to total amount user must pay
        uint256 totalAmountIn = amountIn + referrerFee;
        require(totalAmountIn <= params.amountInMaximum, 'Too much requested');
        
        amountInCached = DEFAULT_AMOUNT_IN_CACHED;
        
        // Return total amount including referrer fee
        return totalAmountIn;
    }
}
