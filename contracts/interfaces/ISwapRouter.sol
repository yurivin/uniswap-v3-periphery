// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity >=0.7.5;
pragma abicoder v2;

import '@uniswap/v3-core/contracts/interfaces/callback/IUniswapV3SwapCallback.sol';

/// @title Router token swapping functionality
/// @notice Functions for swapping tokens via Uniswap V3
interface ISwapRouter is IUniswapV3SwapCallback {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    /// @notice Swaps `amountIn` of one token for as much as possible of another token
    /// @param params The parameters necessary for the swap, encoded as `ExactInputSingleParams` in calldata
    /// @return amountOut The amount of the received token
    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);

    struct ExactInputParams {
        bytes path;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }

    /// @notice Swaps `amountIn` of one token for as much as possible of another along the specified path
    /// @param params The parameters necessary for the multi-hop swap, encoded as `ExactInputParams` in calldata
    /// @return amountOut The amount of the received token
    function exactInput(ExactInputParams calldata params) external payable returns (uint256 amountOut);

    struct ExactOutputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 deadline;
        uint256 amountOut;
        uint256 amountInMaximum;
        uint160 sqrtPriceLimitX96;
    }

    /// @notice Swaps as little as possible of one token for `amountOut` of another token
    /// @param params The parameters necessary for the swap, encoded as `ExactOutputSingleParams` in calldata
    /// @return amountIn The amount of the input token
    function exactOutputSingle(ExactOutputSingleParams calldata params) external payable returns (uint256 amountIn);

    struct ExactOutputParams {
        bytes path;
        address recipient;
        uint256 deadline;
        uint256 amountOut;
        uint256 amountInMaximum;
    }

    /// @notice Swaps as little as possible of one token for `amountOut` of another along the specified path (reversed)
    /// @param params The parameters necessary for the multi-hop swap, encoded as `ExactOutputParams` in calldata
    /// @return amountIn The amount of the input token
    function exactOutput(ExactOutputParams calldata params) external payable returns (uint256 amountIn);

    // Referrer functionality

    /// @notice Returns current referrer configuration
    /// @return referrerAddress Current referrer address
    /// @return feeBasisPoints Current fee in basis points
    function getReferrerConfig() external view returns (address referrerAddress, uint24 feeBasisPoints);

    /// @notice Sets referrer address (owner only)
    /// @param _referrer New referrer address
    function setReferrer(address _referrer) external;

    /// @notice Sets referrer fee rate (owner only)  
    /// @param _feeBasisPoints Fee rate in basis points
    function setReferrerFee(uint24 _feeBasisPoints) external;

    /// @notice Calculate referrer fee for given amount
    /// @param amount Input amount
    /// @return fee Referrer fee amount
    function calculateReferrerFee(uint256 amount) external view returns (uint256 fee);

    /// @notice Returns accumulated referrer fees for a referrer and token
    /// @param referrer Referrer address
    /// @param token Token address
    /// @return amount Accumulated fee amount
    function referrerFees(address referrer, address token) external view returns (uint256 amount);

    /// @notice Collect accumulated referrer fees for a specific token
    /// @param token Token address to collect fees for
    /// @return amount Amount of fees collected
    function collectReferrerFees(address token) external returns (uint256 amount);

    /// @notice Collect accumulated referrer fees for multiple tokens
    /// @param tokens Array of token addresses to collect fees for
    /// @return amounts Array of amounts collected for each token
    function collectReferrerFeesMultiple(address[] calldata tokens) external returns (uint256[] memory amounts);
}
