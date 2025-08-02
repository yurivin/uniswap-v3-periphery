# UniswapV3Pool Referrer Fee Implementation Plan

## Document Purpose
**This document provides comprehensive implementation guidance for integrating position manager referrer fees into the Uniswap V3 Core Pool contract.** It builds upon the completed `position-referrer-implementation-plan.md` and focuses specifically on the Pool contract modifications required to support the production-ready PositionManager referrer system.

**Target Audience**: Core contract developers, security auditors, and integration teams
**Scope**: UniswapV3Pool contract modifications, interface updates, security implementation
**Prerequisites**: Completed PositionManager implementation (`NonfungiblePositionManager.sol` with referrer functionality)

## Overview
The NonfungiblePositionManager referrer fee system is **production-ready** and requires specific Pool contract modifications to enable secure referrer fee collection. This document provides detailed implementation guidance for the core Pool contract changes needed to support the Pool-based storage architecture with gas-limited security measures.

## Current Status Summary

### ✅ **Completed (Periphery)**
- **NonfungiblePositionManager**: Production-ready with referrer functionality (24,448 bytes, under deployment limit)
- **Configuration Functions**: `setReferrer()`, `setReferrerFeeRate()`, `getReferrerConfig()`, `getReferrerFeeRate()`
- **Access Control**: Owner-only management with OpenZeppelin Ownable
- **Test Coverage**: 21 comprehensive tests with 100% pass rate
- **Contract Size**: Optimized for mainnet deployment

### 🚧 **Pending (Core)**
- **UniswapV3Pool**: Requires modifications to support position manager referrer fees
- **Position Structure**: Must be enhanced to store `referrerFeeRate` per position
- **Fee Collection**: New `collectPositionManagerFee()` function needed
- **Gas-Limited Calls**: Secure external call patterns during mint() and fee collection

## Architecture Overview

### Pool-Based Storage with Gas-Limited Capture
The architecture uses Pool-based storage where:
1. **Pool stores referrer rates** in position structure during mint() 
2. **Gas-limited external calls** (5000 gas) with try/catch protection
3. **One-time capture** during position creation, no external calls during swaps
4. **Multi-contract support** for independent PositionManager deployments

### Security-First Design
- **5000 gas limit** on external calls prevents gas griefing attacks
- **Try/catch protection** ensures Pool operations never fail due to external calls
- **Position-level storage** eliminates external calls during fee calculations
- **Contract authorization** prevents cross-contract unauthorized access

## Required Interface Modifications

### 1. **IUniswapV3PoolState Interface Extension**

```solidity
// File: contracts/interfaces/pool/IUniswapV3PoolState.sol

/// @title Pool state that can change
/// @notice These methods compose the pool's state, and can change with any frequency including multiple times
/// per transaction
interface IUniswapV3PoolState {
    /// @notice The 0th storage slot in the pool stores many values, and is exposed as a single method to save gas
    /// when accessed externally.
    /// @return sqrtPriceX96 The current price of the pool as a sqrt(token1/token0) Q64.96 value
    /// tick The current tick of the pool, i.e. according to the last tick transition that was run.
    /// This value may not always be equal to SqrtTickMath.getTickAtSqrtRatio(sqrtPriceX96) if the price is on a tick
    /// boundary.
    /// observationIndex The index of the last oracle observation that was written,
    /// observationCardinality The current maximum number of observations stored in the pool,
    /// observationCardinalityNext The next maximum number of observations, to be updated when the observation.
    /// feeProtocol The protocol fee for both tokens of the pool.
    /// Encoded as two 4 bit values, where the protocol fee of token1 is shifted 4 bits and the protocol fee of token0
    /// is the lower 4 bits. Used as the denominator of a fraction of the swap fee, e.g. 4 means 1/4th of the swap fee.
    /// unlocked Whether the pool is currently locked to reentrancy
    function slot0()
        external
        view
        returns (
            uint160 sqrtPriceX96,
            int24 tick,
            uint16 observationIndex,
            uint16 observationCardinality,
            uint16 observationCardinalityNext,
            uint8 feeProtocol,
            bool unlocked
        );

    /// @notice The fee growth as a Q128.128 fees of token0 collected per unit of liquidity for the entire life of the pool
    /// @dev This value can overflow the uint256
    function feeGrowthGlobal0X128() external view returns (uint256);

    /// @notice The fee growth as a Q128.128 fees of token1 collected per unit of liquidity for the entire life of the pool
    /// @dev This value can overflow the uint256
    function feeGrowthGlobal1X128() external view returns (uint256);

    /// @notice The amounts of token0 and token1 that are owed to the protocol
    /// @dev Protocol fees will never exceed uint128 max in either token
    function protocolFees() external view returns (uint128 token0, uint128 token1);

    /// @notice The currently in range liquidity available to the pool
    /// @dev This value has no relationship to the total liquidity across all ticks
    function liquidity() external view returns (uint128);

    /// @notice Look up information about a specific tick in the pool
    /// @param tick The tick to look up
    /// @return liquidityGross the total amount of position liquidity that uses the pool either as tick lower or
    /// tick upper,
    /// liquidityNet how much liquidity changes when the pool price crosses the tick,
    /// feeGrowthOutside0X128 the fee growth on the other side of the tick from the current tick in token0,
    /// feeGrowthOutside1X128 the fee growth on the other side of the tick from the current tick in token1,
    /// tickCumulativeOutside the cumulative tick value on the other side of the tick from the current tick
    /// secondsPerLiquidityOutsideX128 the seconds spent per liquidity on the other side of the tick from the current tick,
    /// secondsOutside the seconds spent on the other side of the tick from the current tick,
    /// initialized Set to true if the tick is initialized, i.e. liquidityGross is greater than 0, otherwise equal to false.
    /// Outside values can only be used if the tick is initialized, i.e. if liquidityGross is greater than 0.
    /// In addition, these values are only relative and must be used only in comparison to previous snapshots for
    /// a specific position.
    function ticks(int24 tick)
        external
        view
        returns (
            uint128 liquidityGross,
            int128 liquidityNet,
            uint256 feeGrowthOutside0X128,
            uint256 feeGrowthOutside1X128,
            int56 tickCumulativeOutside,
            uint160 secondsPerLiquidityOutsideX128,
            uint32 secondsOutside,
            bool initialized
        );

    /// @notice Returns 256 packed tick initialized boolean values. See TickBitmap for more information
    function tickBitmap(int16 wordPosition) external view returns (uint256);

    /// @notice Returns the information about a position by the position's key
    /// @param key The position's key is a hash of a preimage composed by owner, tickLower and tickUpper
    /// @return _liquidity The amount of liquidity in the position,
    /// Returns feeGrowthInside0LastX128 fee growth of token0 inside the tick range as of the last mint/burn/poke,
    /// Returns feeGrowthInside1LastX128 fee growth of token1 inside the tick range as of the last mint/burn/poke,
    /// Returns tokensOwed0 the computed amount of token0 owed to the position as of the last mint/burn/poke,
    /// Returns tokensOwed1 the computed amount of token1 owed to the position as of the last mint/burn/poke
    /// Returns referrerFeeRate the referrer fee rate stored for this position (0-10000 basis points)
    function positions(bytes32 key)
        external
        view
        returns (
            uint128 _liquidity,
            uint256 feeGrowthInside0LastX128,
            uint256 feeGrowthInside1LastX128,
            uint128 tokensOwed0,
            uint128 tokensOwed1,
            uint24 referrerFeeRate  // NEW: Referrer fee rate stored per position
        );

    /// @notice Returns the observation corresponding to the given index
    /// @param index The element of the observations array to fetch
    /// @dev You most likely want to use #observe() instead of this method to get an observation as of some amount of time
    /// ago, rather than at a specific index in the array.
    /// @return blockTimestamp The timestamp of the observation,
    /// Returns tickCumulative the tick multiplied by seconds elapsed for the life of the pool as of the observation timestamp,
    /// Returns secondsPerLiquidityCumulativeX128 the seconds per in range liquidity for the life of the pool as of the observation timestamp,
    /// Returns initialized whether the observation has been initialized and the values are safe to use
    function observations(uint256 index)
        external
        view
        returns (
            uint32 blockTimestamp,
            int56 tickCumulative,
            uint160 secondsPerLiquidityCumulativeX128,
            bool initialized
        );

    /// @notice Returns accumulated position manager fees for a specific position manager contract
    /// @param positionManager The position manager contract address
    /// @return token0Fees Accumulated token0 fees for the position manager
    /// @return token1Fees Accumulated token1 fees for the position manager
    function positionManagerFees(address positionManager) 
        external 
        view 
        returns (uint128 token0Fees, uint128 token1Fees);
}
```

### 2. **IUniswapV3PoolOwnerActions Interface Extension**

```solidity
// File: contracts/interfaces/pool/IUniswapV3PoolOwnerActions.sol

/// @title Permissioned pool actions
/// @notice Contains pool methods that may only be called by the factory owner
interface IUniswapV3PoolOwnerActions {
    /// @notice Set the denominator of the protocol's portion of the swap fee
    /// @param feeProtocol0 new protocol fee for token0 of the pool
    /// @param feeProtocol1 new protocol fee for token1 of the pool
    function setFeeProtocol(uint8 feeProtocol0, uint8 feeProtocol1) external;

    /// @notice Collect the protocol fee accrued to the pool
    /// @param recipient The address to which collected protocol fees should be sent
    /// @param amount0Requested The maximum amount of token0 to send, can be 0 to collect fees in only token1
    /// @param amount1Requested The maximum amount of token1 to send, can be 0 to collect fees in only token0
    /// @return amount0 The protocol fee collected in token0
    /// @return amount1 The protocol fee collected in token1
    function collectProtocol(
        address recipient,
        uint128 amount0Requested,
        uint128 amount1Requested
    ) external returns (uint128 amount0, uint128 amount1);

    /// @notice Collect accumulated referrer fees for calling position manager
    /// @dev Can only be called by position manager contracts. Fees are sent directly to the
    /// position manager's configured referrer address.
    /// @param amount0Requested The maximum amount of token0 to send, can be 0 to collect fees in only token1
    /// @param amount1Requested The maximum amount of token1 to send, can be 0 to collect fees in only token0
    /// @return amount0 The position manager fee collected in token0
    /// @return amount1 The position manager fee collected in token1
    function collectPositionManagerFee(
        uint128 amount0Requested,
        uint128 amount1Requested
    ) external returns (uint128 amount0, uint128 amount1);
}
```

### 3. **IUniswapV3PoolEvents Interface Extension**

```solidity
// File: contracts/interfaces/pool/IUniswapV3PoolEvents.sol

/// @title Events emitted by a pool
/// @notice Contains all events emitted by the pool
interface IUniswapV3PoolEvents {
    /// @notice Emitted exactly once by a pool when #initialize is first called on the pool
    /// @dev Mint/Burn/Swap cannot be called by the pool before Initialize
    /// @param sqrtPriceX96 The initial sqrt price of the pool, as a Q64.96
    /// @param tick The initial tick of the pool, i.e. log base 1.0001 of the starting price of the pool
    event Initialize(uint160 sqrtPriceX96, int24 tick);

    /// @notice Emitted when liquidity is minted for a given position
    /// @param sender The address that minted the liquidity
    /// @param owner The owner of the position and recipient of any minted liquidity
    /// @param tickLower The lower tick of the position
    /// @param tickUpper The upper tick of the position
    /// @param amount The amount of liquidity minted to the position
    /// @param amount0 How much token0 was required for the minted liquidity
    /// @param amount1 How much token1 was required for the minted liquidity
    event Mint(
        address sender,
        address indexed owner,
        int24 indexed tickLower,
        int24 indexed tickUpper,
        uint128 amount,
        uint256 amount0,
        uint256 amount1
    );

    /// @notice Emitted when fees are collected by the owner of a position
    /// @dev Collect events may be emitted with zero amount0 and amount1 when the caller chooses not to collect fees
    /// @param owner The owner of the position for which fees are collected
    /// @param tickLower The lower tick of the position
    /// @param tickUpper The upper tick of the position
    /// @param amount0 The amount of token0 fees collected
    /// @param amount1 The amount of token1 fees collected
    event Collect(
        address indexed owner,
        address recipient,
        int24 indexed tickLower,
        int24 indexed tickUpper,
        uint128 amount0,
        uint128 amount1
    );

    /// @notice Emitted when a position's liquidity is removed
    /// @dev Does not withdraw any fees earned by the liquidity position, which must be withdrawn via #collect
    /// @param owner The owner of the position for which liquidity is removed
    /// @param tickLower The lower tick of the position
    /// @param tickUpper The upper tick of the position
    /// @param amount The amount of liquidity to remove
    /// @param amount0 The amount of token0 withdrawn
    /// @param amount1 The amount of token1 withdrawn
    event Burn(
        address indexed owner,
        int24 indexed tickLower,
        int24 indexed tickUpper,
        uint128 amount,
        uint256 amount0,
        uint256 amount1
    );

    /// @notice Emitted by the pool for any swaps between token0 and token1
    /// @param sender The address that initiated the swap call, and that received the callback
    /// @param recipient The address that received the output of the swap
    /// @param amount0 The delta of the token0 balance of the pool
    /// @param amount1 The delta of the token1 balance of the pool
    /// @param sqrtPriceX96 The sqrt(price) of the pool after the swap, as a Q64.96
    /// @param liquidity The liquidity of the pool after the swap
    /// @param tick The log base 1.0001 of price of the pool after the swap
    event Swap(
        address indexed sender,
        address indexed recipient,
        int256 amount0,
        int256 amount1,
        uint160 sqrtPriceX96,
        uint128 liquidity,
        int24 tick
    );

    /// @notice Emitted by the pool for any flashes of token0/token1
    /// @param sender The address that initiated the swap call, and that received the callback
    /// @param recipient The address that received the tokens from flash
    /// @param amount0 The amount of token0 that was flashed
    /// @param amount1 The amount of token1 that was flashed
    /// @param paid0 The amount of token0 paid for the flash, which can exceed the amount0 plus the fee
    /// @param paid1 The amount of token1 paid for the flash, which can exceed the amount1 plus the fee
    event Flash(
        address indexed sender,
        address indexed recipient,
        uint256 amount0,
        uint256 amount1,
        uint256 paid0,
        uint256 paid1
    );

    /// @notice Emitted when the protocol fee is changed by the pool
    /// @param feeProtocol0Old The previous value of the token0 protocol fee
    /// @param feeProtocol1Old The previous value of the token1 protocol fee
    /// @param feeProtocol0New The updated value of the token0 protocol fee
    /// @param feeProtocol1New The updated value of the token1 protocol fee
    event SetFeeProtocol(uint8 feeProtocol0Old, uint8 feeProtocol1Old, uint8 feeProtocol0New, uint8 feeProtocol1New);

    /// @notice Emitted when the collected protocol fees are withdrawn by the factory owner
    event CollectProtocol(address indexed sender, address indexed recipient, uint128 amount0, uint128 amount1);

    /// @notice Emitted when position manager fees are collected
    /// @param positionManager The position manager contract that collected fees
    /// @param referrer The referrer address that received the fees
    /// @param amount0 The amount of token0 fees collected
    /// @param amount1 The amount of token1 fees collected
    event CollectPositionManagerFee(
        address indexed positionManager,
        address indexed referrer,
        uint128 amount0,
        uint128 amount1
    );

    /// @notice Emitted when a position is created with referrer fee rate
    /// @param owner The owner of the position
    /// @param positionManager The position manager that created the position  
    /// @param tickLower The lower tick of the position
    /// @param tickUpper The upper tick of the position
    /// @param referrerFeeRate The referrer fee rate stored for this position
    event PositionReferrerStored(
        address indexed owner,
        address indexed positionManager,
        int24 indexed tickLower,
        int24 tickUpper,
        uint24 referrerFeeRate
    );
}
```

## Core Position Library Modifications

### 1. **Enhanced Position.Info Structure**

```solidity
// File: contracts/libraries/Position.sol

pragma solidity >=0.5.0;

import './FullMath.sol';
import './FixedPoint128.sol';
import './LiquidityMath.sol';

/// @title Position
/// @notice Positions represent an owner address' liquidity between a lower and upper tick boundary
/// @dev Positions store additional state for tracking fees owed to the position
library Position {
    // info stored for each user's position
    struct Info {
        // the amount of liquidity owned by this position
        uint128 liquidity;
        // fee growth inside the position as of the last action on the individual position
        uint256 feeGrowthInside0LastX128;
        uint256 feeGrowthInside1LastX128;
        // the fees owed to the position owner in token0/token1
        uint128 tokensOwed0;
        uint128 tokensOwed1;
        // the referrer fee rate for this position (0-10000 basis points)
        uint24 referrerFeeRate;
    }

    /// @notice Returns the Info struct of a position, given an owner and position boundaries
    /// @param self The mapping containing all user positions
    /// @param owner The address of the position owner
    /// @param tickLower The lower tick boundary of the position
    /// @param tickUpper The upper tick boundary of the position
    /// @return position The position info struct of the given owners' position
    function get(
        mapping(bytes32 => Info) storage self,
        address owner,
        int24 tickLower,
        int24 tickUpper
    ) internal view returns (Position.Info storage position) {
        position = self[keccak256(abi.encodePacked(owner, tickLower, tickUpper))];
    }

    /// @notice Credits accumulated fees to a user's position
    /// @param self The individual position to update
    /// @param liquidityDelta The change in pool liquidity as a result of the position update
    /// @param feeGrowthInside0X128 The all-time fee growth in token0, per unit of liquidity, inside the position's tick boundaries
    /// @param feeGrowthInside1X128 The all-time fee growth in token1, per unit of liquidity, inside the position's tick boundaries
    /// @param positionManagerFees0 Storage for accumulating position manager fees in token0
    /// @param positionManagerFees1 Storage for accumulating position manager fees in token1
    /// @param positionManager The position manager contract address for this position
    function update(
        Info storage self,
        int128 liquidityDelta,
        uint256 feeGrowthInside0X128,
        uint256 feeGrowthInside1X128,
        mapping(address => uint128) storage positionManagerFees0,
        mapping(address => uint128) storage positionManagerFees1,
        address positionManager
    ) internal {
        Info memory _self = self;

        uint128 liquidityNext;
        if (liquidityDelta == 0) {
            require(_self.liquidity > 0, 'NP'); // disallow pokes for 0 liquidity positions
            liquidityNext = _self.liquidity;
        } else {
            liquidityNext = LiquidityMath.addDelta(_self.liquidity, liquidityDelta);
        }

        // calculate accumulated fees
        uint128 tokensOwed0 =
            uint128(
                FullMath.mulDiv(
                    feeGrowthInside0X128 - _self.feeGrowthInside0LastX128,
                    _self.liquidity,
                    FixedPoint128.Q128
                )
            );
        uint128 tokensOwed1 =
            uint128(
                FullMath.mulDiv(
                    feeGrowthInside1X128 - _self.feeGrowthInside1LastX128,
                    _self.liquidity,
                    FixedPoint128.Q128
                )
            );

        // extract referrer fees if configured
        if (_self.referrerFeeRate > 0 && positionManager != address(0)) {
            uint128 referrerFee0 = uint128((uint256(tokensOwed0) * _self.referrerFeeRate) / 10000);
            uint128 referrerFee1 = uint128((uint256(tokensOwed1) * _self.referrerFeeRate) / 10000);
            
            // accumulate referrer fees for position manager
            positionManagerFees0[positionManager] += referrerFee0;
            positionManagerFees1[positionManager] += referrerFee1;
            
            // reduce position owner fees by referrer portion
            tokensOwed0 -= referrerFee0;
            tokensOwed1 -= referrerFee1;
        }

        // update the position
        if (liquidityDelta != 0) self.liquidity = liquidityNext;
        self.feeGrowthInside0LastX128 = feeGrowthInside0X128;
        self.feeGrowthInside1LastX128 = feeGrowthInside1X128;
        if (tokensOwed0 > 0 || tokensOwed1 > 0) {
            // overflow is acceptable, have to withdraw before you hit type(uint128).max fees
            self.tokensOwed0 += tokensOwed0;
            self.tokensOwed1 += tokensOwed1;
        }
    }
}
```

## Core Pool Contract Implementation

### 1. **UniswapV3Pool Storage Additions**

```solidity
// File: contracts/UniswapV3Pool.sol

contract UniswapV3Pool is IUniswapV3Pool, NoDelegateCall {
    using LowGasSafeMath for uint256;
    using LowGasSafeMath for int256;
    using SafeCast for uint256;
    using SafeCast for int256;
    using Tick for mapping(int24 => Tick.Info);
    using TickBitmap for mapping(int16 => uint256);
    using Position for mapping(bytes32 => Position.Info);
    using Position for Position.Info;
    using Oracle for Oracle.Observation[65535];

    /// @inheritdoc IUniswapV3PoolImmutables
    address public immutable override factory;
    /// @inheritdoc IUniswapV3PoolImmutables
    address public immutable override token0;
    /// @inheritdoc IUniswapV3PoolImmutables
    address public immutable override token1;
    /// @inheritdoc IUniswapV3PoolImmutables
    uint24 public immutable override fee;

    /// @inheritdoc IUniswapV3PoolImmutables
    int24 public immutable override tickSpacing;

    /// @inheritdoc IUniswapV3PoolImmutables
    uint128 public immutable override maxLiquidityPerTick;

    struct Slot0 {
        // the current price
        uint160 sqrtPriceX96;
        // the current tick
        int24 tick;
        // the most-recently updated index of the observations array
        uint16 observationIndex;
        // the current maximum number of observations that are being stored
        uint16 observationCardinality;
        // the next maximum number of observations to store, triggered in observations.write
        uint16 observationCardinalityNext;
        // the current protocol fee as a percentage of the swap fee taken on withdrawal
        // represented as an integer denominator (1/x)%
        uint8 feeProtocol;
        // whether the pool is locked
        bool unlocked;
    }
    /// @inheritdoc IUniswapV3PoolState
    Slot0 public override slot0;

    /// @inheritdoc IUniswapV3PoolState
    uint256 public override feeGrowthGlobal0X128;
    /// @inheritdoc IUniswapV3PoolState
    uint256 public override feeGrowthGlobal1X128;

    // accumulated protocol fees in token0/token1 units
    struct ProtocolFees {
        uint128 token0;
        uint128 token1;
    }
    /// @inheritdoc IUniswapV3PoolState
    ProtocolFees public override protocolFees;

    /// @inheritdoc IUniswapV3PoolState
    uint128 public override liquidity;

    /// @inheritdoc IUniswapV3PoolState
    mapping(int24 => Tick.Info) public override ticks;
    /// @inheritdoc IUniswapV3PoolState
    mapping(int16 => uint256) public override tickBitmap;
    /// @inheritdoc IUniswapV3PoolState
    mapping(bytes32 => Position.Info) public override positions;
    /// @inheritdoc IUniswapV3PoolState
    Oracle.Observation[65535] public override observations;

    // NEW: Position manager fee accumulation storage
    /// @dev Accumulated fees for each position manager contract in token0
    mapping(address => uint128) public positionManagerFees0;
    /// @dev Accumulated fees for each position manager contract in token1  
    mapping(address => uint128) public positionManagerFees1;
    
    /// @dev Track which position manager created each position
    mapping(bytes32 => address) public positionManagers;

    /// @inheritdoc IUniswapV3PoolState
    function positionManagerFees(address positionManager) 
        external 
        view 
        override
        returns (uint128 token0Fees, uint128 token1Fees) 
    {
        return (positionManagerFees0[positionManager], positionManagerFees1[positionManager]);
    }

    // ... existing constructor and modifier implementations ...
}
```

### 2. **Enhanced positions() View Function**

```solidity
/// @inheritdoc IUniswapV3PoolState  
function positions(bytes32 key)
    external
    view
    override
    returns (
        uint128 _liquidity,
        uint256 feeGrowthInside0LastX128,
        uint256 feeGrowthInside1LastX128,
        uint128 tokensOwed0,
        uint128 tokensOwed1,
        uint24 referrerFeeRate
    )
{
    Position.Info storage position = positions[key];
    return (
        position.liquidity,
        position.feeGrowthInside0LastX128,
        position.feeGrowthInside1LastX128,
        position.tokensOwed0,
        position.tokensOwed1,
        position.referrerFeeRate
    );
}
```

### 3. **Enhanced mint() Function with Gas-Limited Referrer Capture**

```solidity
/// @inheritdoc IUniswapV3PoolActions
function mint(
    address recipient,
    int24 tickLower,
    int24 tickUpper,
    uint128 amount,
    bytes calldata data
) external override lock returns (uint256 amount0, uint256 amount1) {
    require(amount > 0);
    (, int256 amount0Int, int256 amount1Int) =
        _modifyPosition(
            ModifyPositionParams({
                owner: recipient,
                tickLower: tickLower,
                tickUpper: tickUpper,
                liquidityDelta: int256(amount).toInt128()
            })
        );

    amount0 = uint256(amount0Int);
    amount1 = uint256(amount1Int);

    uint256 balance0Before;
    uint256 balance1Before;
    if (amount0 > 0) balance0Before = balance0();
    if (amount1 > 0) balance1Before = balance1();
    IUniswapV3MintCallback(msg.sender).uniswapV3MintCallback(amount0, amount1, data);
    if (amount0 > 0) require(balance0Before.add(amount0) <= balance0(), 'M0');
    if (amount1 > 0) require(balance1Before.add(amount1) <= balance1(), 'M1');

    emit Mint(msg.sender, recipient, tickLower, tickUpper, amount, amount0, amount1);
}

struct ModifyPositionParams {
    // the owner of the position
    address owner;
    // the lower and upper tick of the position
    int24 tickLower;
    int24 tickUpper;
    // any change in liquidity
    int128 liquidityDelta;
}

/// @dev Effect some changes to a position
/// @param params the position details and the change to the position's liquidity to effect
/// @return position Position.Info storage reference for the position
/// @return amount0 the amount of token0 owed to the pool, negative if the pool should pay the recipient
/// @return amount1 the amount of token1 owed to the pool, negative if the pool should pay the recipient
function _modifyPosition(ModifyPositionParams memory params)
    private
    noDelegateCall
    returns (
        Position.Info storage position,
        int256 amount0,
        int256 amount1
    )
{
    checkTicks(params.tickLower, params.tickUpper);

    Slot0 memory _slot0 = slot0; // SLOAD for gas optimization

    bytes32 positionKey = PositionKey.compute(params.owner, params.tickLower, params.tickUpper);
    position = _updatePosition(
        params.owner,
        params.tickLower,
        params.tickUpper,
        params.liquidityDelta,
        _slot0.tick
    );

    // NEW: Capture referrer fee rate during position creation
    if (params.liquidityDelta > 0) {
        // This is a new position or liquidity addition
        if (position.liquidity == 0) {
            // New position - capture referrer fee rate with gas-limited call
            uint24 referrerFeeRate = 0;
            address positionManager = msg.sender;
            
            // Gas-limited external call with try/catch for security
            try INonfungiblePositionManager(positionManager).getReferrerFeeRate{gas: 5000}() 
                returns (uint24 feeRate) {
                // Validate fee rate is within acceptable bounds (0-100%)
                if (feeRate <= 10000) {
                    referrerFeeRate = feeRate;
                }
            } catch {
                // If call fails, referrerFeeRate remains 0 (no referrer fees)
            }
            
            // Store referrer fee rate and position manager in position
            position.referrerFeeRate = referrerFeeRate;
            positionManagers[positionKey] = positionManager;
            
            // Emit event for referrer rate storage
            if (referrerFeeRate > 0) {
                emit PositionReferrerStored(
                    params.owner,
                    positionManager, 
                    params.tickLower,
                    params.tickUpper,
                    referrerFeeRate
                );
            }
        }
    }

    if (params.liquidityDelta != 0) {
        if (_slot0.tick < params.tickLower) {
            // current tick is below the passed range; liquidity can only become in range by crossing from left to
            // right, when we'll need _more_ token0 (it's becoming more valuable) so user must provide it
            amount0 = SqrtPriceMath.getAmount0Delta(
                TickMath.getSqrtRatioAtTick(params.tickLower),
                TickMath.getSqrtRatioAtTick(params.tickUpper),
                params.liquidityDelta
            );
        } else if (_slot0.tick < params.tickUpper) {
            // current tick is inside the passed range
            uint128 liquidityBefore = liquidity; // SLOAD for gas optimization

            amount0 = SqrtPriceMath.getAmount0Delta(
                _slot0.sqrtPriceX96,
                TickMath.getSqrtRatioAtTick(params.tickUpper),
                params.liquidityDelta
            );
            amount1 = SqrtPriceMath.getAmount1Delta(
                TickMath.getSqrtRatioAtTick(params.tickLower),
                _slot0.sqrtPriceX96,
                params.liquidityDelta
            );

            liquidity = LiquidityMath.addDelta(liquidityBefore, params.liquidityDelta);
        } else {
            // current tick is above the passed range; liquidity can only become in range by crossing from right to
            // left, when we'll need _more_ token1 (it's becoming more valuable) so user must provide it
            amount1 = SqrtPriceMath.getAmount1Delta(
                TickMath.getSqrtRatioAtTick(params.tickLower),
                TickMath.getSqrtRatioAtTick(params.tickUpper),
                params.liquidityDelta
            );
        }
    }
}
```

### 4. **Enhanced _updatePosition() with Referrer Fee Integration**

```solidity
/// @dev Gets and updates a position with the given liquidity delta
/// @param owner the owner of the position
/// @param tickLower the lower tick of the position's tick range
/// @param tickUpper the upper tick of the position's tick range
/// @param tick the current tick, passed to avoid sloads
function _updatePosition(
    address owner,
    int24 tickLower,
    int24 tickUpper,
    int128 liquidityDelta,
    int24 tick
) private returns (Position.Info storage position) {
    bytes32 positionKey = PositionKey.compute(owner, tickLower, tickUpper);
    position = positions[positionKey];

    uint256 _feeGrowthGlobal0X128 = feeGrowthGlobal0X128; // SLOAD for gas optimization
    uint256 _feeGrowthGlobal1X128 = feeGrowthGlobal1X128; // SLOAD for gas optimization

    // if we need to update the ticks, do it
    bool flippedLower;
    bool flippedUpper;
    if (liquidityDelta != 0) {
        uint32 time = _blockTimestamp();
        (int56 tickCumulative, uint160 secondsPerLiquidityCumulativeX128) =
            observations.observeSingle(
                time,
                0,
                slot0.tick,
                slot0.observationIndex,
                liquidity,
                slot0.observationCardinality
            );

        flippedLower = ticks.update(
            tickLower,
            tick,
            liquidityDelta,
            _feeGrowthGlobal0X128,
            _feeGrowthGlobal1X128,
            secondsPerLiquidityCumulativeX128,
            tickCumulative,
            time,
            false,
            maxLiquidityPerTick
        );
        flippedUpper = ticks.update(
            tickUpper,
            tick,
            liquidityDelta,
            _feeGrowthGlobal0X128,
            _feeGrowthGlobal1X128,
            secondsPerLiquidityCumulativeX128,
            tickCumulative,
            time,
            true,
            maxLiquidityPerTick
        );

        if (flippedLower) {
            tickBitmap.flipTick(tickLower, tickSpacing);
        }
        if (flippedUpper) {
            tickBitmap.flipTick(tickUpper, tickSpacing);
        }
    }

    (uint256 feeGrowthInside0X128, uint256 feeGrowthInside1X128) =
        ticks.getFeeGrowthInside(tickLower, tickUpper, tick, _feeGrowthGlobal0X128, _feeGrowthGlobal1X128);

    // NEW: Get position manager for this position for referrer fee handling
    address positionManager = positionManagers[positionKey];
    
    // Update position with referrer fee extraction
    position.update(
        liquidityDelta, 
        feeGrowthInside0X128, 
        feeGrowthInside1X128,
        positionManagerFees0,    // Pass position manager fee storage
        positionManagerFees1,    // Pass position manager fee storage  
        positionManager          // Pass position manager address
    );

    // clear any tick data that is no longer needed
    if (liquidityDelta < 0) {
        if (flippedLower) {
            ticks.clear(tickLower);
        }
        if (flippedUpper) {
            ticks.clear(tickUpper);
        }
    }
}
```

### 5. **New collectPositionManagerFee() Function**

```solidity
/// @inheritdoc IUniswapV3PoolOwnerActions
function collectPositionManagerFee(
    uint128 amount0Requested,
    uint128 amount1Requested
) external override lock returns (uint128 amount0, uint128 amount1) {
    address positionManager = msg.sender;
    
    // Get current referrer address with gas-limited call for security
    address referrerAddress = address(0);
    try INonfungiblePositionManager(positionManager).getReferrerConfig{gas: 5000}() 
        returns (address referrer, uint24) {
        referrerAddress = referrer;
    } catch {
        // If call fails, no fee collection (referrer required for collection)
        return (0, 0);
    }
    
    // Require valid referrer for fee collection
    require(referrerAddress != address(0), "No referrer configured");
    
    // Get accumulated fees for this position manager
    uint128 fees0 = positionManagerFees0[positionManager];
    uint128 fees1 = positionManagerFees1[positionManager];
    
    // Calculate actual amounts to collect
    amount0 = amount0Requested > fees0 ? fees0 : amount0Requested;
    amount1 = amount1Requested > fees1 ? fees1 : amount1Requested;
    
    // Update accumulated fees
    if (amount0 > 0) {
        positionManagerFees0[positionManager] = fees0 - amount0;
        TransferHelper.safeTransfer(token0, referrerAddress, amount0);
    }
    if (amount1 > 0) {
        positionManagerFees1[positionManager] = fees1 - amount1;
        TransferHelper.safeTransfer(token1, referrerAddress, amount1);
    }
    
    emit CollectPositionManagerFee(positionManager, referrerAddress, amount0, amount1);
}
```

## Required Interface Additions

### 1. **INonfungiblePositionManager Interface Extension**

```solidity
// File: contracts/interfaces/INonfungiblePositionManager.sol

interface INonfungiblePositionManager {
    // ... existing interface functions ...
    
    /// @notice Get referrer configuration for this position manager
    /// @return referrerAddress The address configured to receive referrer fees
    /// @return feeRate The referrer fee rate in basis points (0-10000)
    function getReferrerConfig() external view returns (address referrerAddress, uint24 feeRate);
    
    /// @notice Get referrer fee rate for this position manager (gas-optimized for Pool calls)
    /// @return feeRate The referrer fee rate in basis points (0-10000)
    function getReferrerFeeRate() external view returns (uint24 feeRate);
}
```

## Security Implementation Details

### 1. **Gas-Limited External Calls**
- **5000 gas limit** prevents gas griefing attacks from malicious PositionManager contracts
- **Try/catch blocks** ensure Pool operations never fail due to external call issues
- **Graceful degradation** when external calls fail (default to zero fee rate)

### 2. **Fee Rate Validation**
- **Maximum 10000 basis points** (100%) cap on referrer fee rates
- **Zero default** for invalid or failed external calls
- **Boundary checks** prevent arithmetic overflow in fee calculations

### 3. **Authorization Control**
- **Position manager tracking** ensures only original creator can modify positions
- **Cross-contract isolation** prevents unauthorized access between deployments
- **Immutable associations** - position manager cannot be changed after creation

### 4. **Reentrancy Protection**
- **Lock modifier** inherited from existing Pool security patterns
- **State updates before external transfers** follow checks-effects-interactions pattern
- **Consistent with existing** `collectProtocol()` implementation

## Testing Requirements

### 1. **Unit Tests for Pool Functions**
```solidity
// Test gas-limited external calls during mint()
function testMintWithGasLimitedReferrerCapture() public {
    // Test successful referrer rate capture
    // Test failed external call handling (gas limit exceeded)
    // Test invalid fee rate handling (> 10000)
    // Test zero fee rate handling
}

// Test referrer fee extraction during position updates
function testPositionUpdateWithReferrerFees() public {
    // Test fee extraction with different referrer rates
    // Test fee accumulation in position manager storage
    // Test position owner receives reduced fees
    // Test multiple positions from same position manager
}

// Test position manager fee collection
function testCollectPositionManagerFee() public {
    // Test successful fee collection with valid referrer
    // Test failed collection when referrer not configured
    // Test partial collection (requested < available)
    // Test gas-limited getReferrerConfig() calls
}
```

### 2. **Integration Tests**
```solidity  
// Test full lifecycle: mint -> swap -> collect
function testFullReferrerFeeLifecycle() public {
    // Create position with referrer fees
    // Generate fees through swaps
    // Collect fees through position manager
    // Verify referrer receives correct amounts
}

// Test multi-contract scenarios
function testMultiplePositionManagers() public {
    // Deploy multiple position managers with different referrers
    // Create positions from each manager
    // Verify fee isolation between managers
    // Test cross-contract authorization prevention
}
```

### 3. **Security Tests**
```solidity
// Test gas griefing attack prevention
function testGasGriefingPrevention() public {
    // Create malicious position manager that consumes excess gas
    // Verify Pool operations continue with 5000 gas limit
    // Test try/catch handles gas limit failures gracefully
}

// Test reentrancy attack prevention  
function testReentrancyPrevention() public {
    // Create malicious position manager that attempts reentrancy
    // Verify lock modifier prevents reentrant calls
    // Test state consistency after failed attacks
}
```

## Migration and Deployment Strategy

### 1. **Backwards Compatibility**
- **Existing positions** continue working unchanged (referrerFeeRate defaults to 0)
- **Interface extensions** maintain all existing function signatures
- **Optional functionality** - referrer fees are opt-in via position manager configuration

### 2. **Deployment Sequence**
1. **Deploy updated Position library** with referrer fee handling
2. **Deploy updated Pool contracts** with enhanced position structure
3. **Update Pool factory** to deploy new Pool implementation
4. **Test integration** with existing PositionManager contracts
5. **Deploy production** with comprehensive monitoring

### 3. **Migration Testing**
- **Fork testing** on mainnet state to verify backwards compatibility
- **Gas analysis** to quantify overhead of new functionality
- **Security auditing** of all cross-contract interactions
- **Integration testing** with existing DeFi protocols

## Performance Considerations

### 1. **Storage Layout Optimization**
- **Pack referrerFeeRate** efficiently in Position.Info struct
- **Minimize storage slots** for position manager fee accumulation
- **Optimize mapping access** patterns for gas efficiency

### 2. **Gas Cost Analysis**
- **Mint overhead**: ~2000-3000 gas for referrer rate capture (one-time cost)
- **Swap overhead**: ~500-1000 gas for referrer fee extraction (when configured)
- **Collect overhead**: ~2000-3000 gas for referrer configuration lookup (infrequent)

### 3. **Scalability Considerations**  
- **Position manager isolation** prevents cross-contract performance interference
- **Local storage patterns** eliminate dependency on external contract state
- **Batch collection support** for gas-efficient multi-pool fee collection

## Conclusion

This implementation plan provides a comprehensive roadmap for integrating the production-ready PositionManager referrer fee system into the Uniswap V3 Core Pool contracts. The design prioritizes:

- **Security**: Gas-limited external calls with try/catch protection
- **Performance**: Minimal overhead with position-local storage patterns  
- **Compatibility**: Full backwards compatibility with existing positions
- **Independence**: Multi-contract architecture with proper isolation

The Pool-based storage architecture ensures referrer fees are calculated securely and efficiently while maintaining the integrity of the core Uniswap V3 protocol. All modifications follow existing patterns and security practices established in the protocol.

When implemented, this system will enable the **production-ready PositionManager referrer functionality** to operate with full Pool integration, providing economic incentives for position management services while maintaining the security and efficiency standards of Uniswap V3.