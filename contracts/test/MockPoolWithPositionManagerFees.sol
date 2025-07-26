// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity =0.7.6;

import '../interfaces/IUniswapV3PoolWithPositionManagerFees.sol';
import '../interfaces/INonfungiblePositionManager.sol';

/// @title Mock pool contract for testing position manager fee collection
/// @notice Simulates pool behavior for position manager referrer fee functionality testing
contract MockPoolWithPositionManagerFees is IUniswapV3PoolWithPositionManagerFees {
    // Storage for accumulated fees per position manager
    mapping(address => uint128) public accumulatedFees0;
    mapping(address => uint128) public accumulatedFees1;
    
    // Mock token addresses
    address public override token0;
    address public override token1;
    uint24 public override fee;
    
    // Events
    event FeesCollected(address indexed positionManager, address indexed referrer, uint128 amount0, uint128 amount1);
    event FeesSet(address indexed positionManager, uint128 amount0, uint128 amount1);

    constructor(address _token0, address _token1, uint24 _fee) {
        token0 = _token0;
        token1 = _token1;
        fee = _fee;
    }

    /// @notice Set accumulated fees for a position manager (for testing)
    function setAccumulatedFees(address positionManager, uint128 amount0, uint128 amount1) external {
        accumulatedFees0[positionManager] = amount0;
        accumulatedFees1[positionManager] = amount1;
        emit FeesSet(positionManager, amount0, amount1);
    }

    /// @inheritdoc IUniswapV3PoolWithPositionManagerFees
    function collectPositionManagerFee() external override returns (uint128 amount0, uint128 amount1) {
        address positionManager = msg.sender;
        
        // Get accumulated fees for this position manager
        amount0 = accumulatedFees0[positionManager];
        amount1 = accumulatedFees1[positionManager];
        
        // Get referrer from position manager
        (address referrer, ) = INonfungiblePositionManager(positionManager).getReferrerConfig();
        require(referrer != address(0), "No referrer configured");
        
        // Clear accumulated fees
        accumulatedFees0[positionManager] = 0;
        accumulatedFees1[positionManager] = 0;
        
        // In a real implementation, we would transfer tokens to the referrer
        // For testing, we just emit an event to verify the behavior
        emit FeesCollected(positionManager, referrer, amount0, amount1);
        
        return (amount0, amount1);
    }

    /// @inheritdoc IUniswapV3PoolWithPositionManagerFees
    function getPositionManagerFees(address positionManager) external view override returns (uint128 amount0, uint128 amount1) {
        return (accumulatedFees0[positionManager], accumulatedFees1[positionManager]);
    }

    // Minimal implementation of required IUniswapV3Pool functions for compilation
    function factory() external pure override returns (address) { return address(0); }
    function tickSpacing() external pure override returns (int24) { return 1; }
    function maxLiquidityPerTick() external pure override returns (uint128) { return 0; }
    
    function slot0() external pure override returns (
        uint160 sqrtPriceX96,
        int24 tick,
        uint16 observationIndex,
        uint16 observationCardinality,
        uint16 observationCardinalityNext,
        uint8 feeProtocol,
        bool unlocked
    ) {
        return (0, 0, 0, 0, 0, 0, false);
    }
    
    function feeGrowthGlobal0X128() external pure override returns (uint256) { return 0; }
    function feeGrowthGlobal1X128() external pure override returns (uint256) { return 0; }
    function protocolFees() external pure override returns (uint128, uint128) { return (0, 0); }
    function liquidity() external pure override returns (uint128) { return 0; }
    
    function ticks(int24) external pure override returns (
        uint128 liquidityGross,
        int128 liquidityNet,
        uint256 feeGrowthOutside0X128,
        uint256 feeGrowthOutside1X128,
        int56 tickCumulativeOutside,
        uint160 secondsPerLiquidityOutsideX128,
        uint32 secondsOutside,
        bool initialized
    ) {
        return (0, 0, 0, 0, 0, 0, 0, false);
    }
    
    function tickBitmap(int16) external pure override returns (uint256) { return 0; }
    
    function positions(bytes32) external pure override returns (
        uint128 liquidity,
        uint256 feeGrowthInside0LastX128,
        uint256 feeGrowthInside1LastX128,
        uint128 tokensOwed0,
        uint128 tokensOwed1
    ) {
        return (0, 0, 0, 0, 0);
    }
    
    function observations(uint256) external pure override returns (
        uint32 blockTimestamp,
        int56 tickCumulative,
        uint160 secondsPerLiquidityCumulativeX128,
        bool initialized
    ) {
        return (0, 0, 0, false);
    }
    
    function initialize(uint160) external pure override {}
    function mint(address, int24, int24, uint128, bytes calldata) external pure override returns (uint256, uint256) { return (0, 0); }
    function collect(address, int24, int24, uint128, uint128) external pure override returns (uint128, uint128) { return (0, 0); }
    function burn(int24, int24, uint128) external pure override returns (uint256, uint256) { return (0, 0); }
    function swap(address, bool, int256, uint160, bytes calldata) external pure override returns (int256, int256) { return (0, 0); }
    function flash(address, uint256, uint256, bytes calldata) external pure override {}
    function increaseObservationCardinalityNext(uint16) external pure override {}
    function collectProtocol(address, uint128, uint128) external pure override returns (uint128, uint128) { return (0, 0); }
    function setFeeProtocol(uint8, uint8) external pure override {}
    
    function observe(uint32[] calldata) external pure override returns (int56[] memory, uint160[] memory) {
        int56[] memory tickCumulatives = new int56[](1);
        uint160[] memory secondsPerLiquidityCumulativeX128s = new uint160[](1);
        return (tickCumulatives, secondsPerLiquidityCumulativeX128s);
    }
    
    function snapshotCumulativesInside(int24, int24) external pure override returns (int56, uint160, uint32) {
        return (0, 0, 0);
    }
}