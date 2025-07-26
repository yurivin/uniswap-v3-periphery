// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity >=0.5.0;

import '@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol';

/// @title Extended pool interface with position manager fee collection
/// @notice Extends the standard pool interface with position manager referrer fee functionality
interface IUniswapV3PoolWithPositionManagerFees is IUniswapV3Pool {
    /// @notice Collect accumulated referrer fees for the calling position manager
    /// @dev Can only be called by position manager contracts
    /// @return amount0 The amount of token0 collected and sent to the referrer
    /// @return amount1 The amount of token1 collected and sent to the referrer
    function collectPositionManagerFee() external returns (uint128 amount0, uint128 amount1);

    /// @notice Get accumulated fees for a specific position manager
    /// @param positionManager The position manager to query fees for
    /// @return amount0 The amount of token0 accumulated
    /// @return amount1 The amount of token1 accumulated
    function getPositionManagerFees(address positionManager) external view returns (uint128 amount0, uint128 amount1);
}