# UniswapV3Pool Contract Referrer Fee Implementation Document

## Document Purpose
This document provides detailed implementation guidance for modifying the Uniswap V3 Core pool contracts to support Position Manager referrer fees. It serves as a companion to the Position Manager implementation plan and focuses specifically on the core pool contract changes required.

**Target Audience**: Core contract developers, security auditors, protocol maintainers
**Scope**: Core pool contract modifications, storage enhancements, interface additions
**Companion Document**: `position-referrer-implementation-plan.md` (Position Manager implementation)

## Executive Summary

The Pool contract modifications enable Position Manager referrer fees through a two-level architecture:
1. **Position Manager Level (Periphery)**: Stores referrer configuration and manages fee collection requests
2. **Pool Level (Core)**: Tracks position managers, extracts referrer fees, and accumulates fees per position manager

Key features:
- **Position Manager Tracking**: Pool stores which Position Manager created each position
- **Dynamic Fee Lookup**: Real-time referrer configuration retrieval from Position Manager contracts
- **Integrated Fee Extraction**: Referrer fees extracted during existing position fee calculations
- **Direct Fee Collection**: Position Managers collect fees directly from pools (like protocol fees)
- **Cross-Contract Authorization**: Only original Position Manager can modify positions it created

## Current Pool Contract Architecture Analysis

### Existing Position Storage Structure
```solidity
// Current Position struct in Position.sol
struct Info {
    uint128 liquidity;                    // Position liquidity amount
    uint256 feeGrowthInside0LastX128;     // Fee growth tracker for token0
    uint256 feeGrowthInside1LastX128;     // Fee growth tracker for token1
    uint128 tokensOwed0;                  // Accumulated fees in token0
    uint128 tokensOwed1;                  // Accumulated fees in token1
}

// Current storage pattern
mapping(bytes32 => Position.Info) public override positions;
```

### Current Fee Collection Patterns
```solidity
// Protocol fee collection pattern (existing)
function collectProtocol(
    address recipient,
    uint128 amount0Requested,
    uint128 amount1Requested
) external returns (uint128 amount0, uint128 amount1);

// Protocol fee storage (existing)
struct ProtocolFees {
    uint128 token0;
    uint128 token1;
}
ProtocolFees public override protocolFees;
```

### Current Position Management Functions
```solidity
// Position creation
function mint(address recipient, int24 tickLower, int24 tickUpper, uint128 amount, bytes calldata data) external;

// Position modification  
function burn(int24 tickLower, int24 tickUpper, uint128 amount) external;

// Fee collection for position owners
function collect(address recipient, int24 tickLower, int24 tickUpper, uint128 amount0Requested, uint128 amount1Requested) external;
```

## Required Pool Contract Modifications

### 1. Enhanced Position Storage Structure

#### A. Position Struct Enhancement
```solidity
// MODIFIED: Enhanced Position struct with position manager tracking
// File: contracts/libraries/Position.sol
library Position {
    struct Info {
        uint128 liquidity;                    // Existing field
        uint256 feeGrowthInside0LastX128;     // Existing field
        uint256 feeGrowthInside1LastX128;     // Existing field
        uint128 tokensOwed0;                  // Existing field
        uint128 tokensOwed1;                  // Existing field
        address positionManager;              // NEW: Track which Position Manager created this position
    }
    
    // Existing Position.update function will be modified to handle referrer fees
    function update(
        Info storage self,
        int128 liquidityDelta,
        uint256 feeGrowthInside0X128,
        uint256 feeGrowthInside1X128
    ) internal {
        // Enhanced implementation with referrer fee extraction
        // (detailed implementation provided in later section)
    }
}
```

**Key Changes:**
- **New Field**: `address positionManager` added to track which Position Manager created the position
- **Storage Impact**: Additional 20 bytes per position (1 storage slot if packed with other fields)
- **Authorization**: Enables position manager authorization for position modifications

#### B. Position Manager Fee Storage
```solidity
// NEW: Position Manager fee accumulation storage  
// File: contracts/UniswapV3Pool.sol
struct PositionManagerFees {
    uint128 token0;    // Accumulated fees in token0
    uint128 token1;    // Accumulated fees in token1
}

// Storage mapping: position manager address → accumulated fees
mapping(address => PositionManagerFees) public positionManagerFees;
```

**Storage Pattern:**
- Follows existing `protocolFees` pattern for consistency
- Each Position Manager contract accumulates fees separately
- Supports multiple Position Manager contracts per pool
- Direct fee accumulation during position fee calculations

### 2. Position Manager Interface for Pool Integration

```solidity
// NEW: Interface for Position Manager integration
// File: contracts/interfaces/INonfungiblePositionManagerMinimal.sol
interface INonfungiblePositionManagerMinimal {
    /// @notice Get referrer configuration for this Position Manager
    /// @return referrerAddress Address to receive referrer fees
    /// @return feeRate Fee rate in basis points (0-10000 = 0%-100%)
    function getReferrerConfig() external view returns (address referrerAddress, uint24 feeRate);
}
```

**Usage Pattern:**
- Pool contracts call this interface to get real-time referrer configuration
- Dynamic lookup ensures changes to Position Manager configuration immediately affect all positions
- Minimal interface reduces dependency surface area

### 3. Enhanced Position Fee Calculation

#### A. Modified Position Update Function
```solidity
// MODIFIED: Enhanced _updatePosition with referrer fee extraction
// File: contracts/UniswapV3Pool.sol (internal function)
function _updatePosition(
    address owner,
    int24 tickLower,
    int24 tickUpper,
    int128 liquidityDelta,
    int24 tick
) private returns (Position.Info storage position) {
    bytes32 positionKey = PositionKey.compute(owner, tickLower, tickUpper);
    position = positions[positionKey];
    
    // Get fee growth inside the position's tick range
    (uint256 feeGrowthInside0X128, uint256 feeGrowthInside1X128) = 
        ticks.getFeeGrowthInside(tickLower, tickUpper, tick, feeGrowthGlobal0X128, feeGrowthGlobal1X128);
    
    // Calculate accumulated fees for this position
    uint256 tokensOwed0 = FullMath.mulDiv(
        feeGrowthInside0X128 - position.feeGrowthInside0LastX128,
        position.liquidity,
        FixedPoint128.Q128
    );
    uint256 tokensOwed1 = FullMath.mulDiv(
        feeGrowthInside1X128 - position.feeGrowthInside1LastX128,
        position.liquidity,
        FixedPoint128.Q128
    );
    
    // NEW: Extract referrer fees if position has an associated Position Manager
    if (position.positionManager != address(0)) {
        (uint256 referrerFee0, uint256 referrerFee1) = _extractReferrerFees(
            position.positionManager,
            tokensOwed0,
            tokensOwed1
        );
        
        // Reduce position owner fees by referrer amount
        tokensOwed0 -= referrerFee0;
        tokensOwed1 -= referrerFee1;
    }
    
    // Update position with remaining fees
    position.liquidity = LiquidityMath.addDelta(position.liquidity, liquidityDelta);
    position.feeGrowthInside0LastX128 = feeGrowthInside0X128;
    position.feeGrowthInside1LastX128 = feeGrowthInside1X128;
    
    if (tokensOwed0 > 0 || tokensOwed1 > 0) {
        position.tokensOwed0 += uint128(tokensOwed0);
        position.tokensOwed1 += uint128(tokensOwed1);
    }
}
```

#### B. Referrer Fee Extraction Function
```solidity
// NEW: Referrer fee extraction helper function
// File: contracts/UniswapV3Pool.sol (internal function)
function _extractReferrerFees(
    address positionManager,
    uint256 totalFees0,
    uint256 totalFees1
) private returns (uint256 referrerFee0, uint256 referrerFee1) {
    // Dynamic lookup: Get current referrer configuration from Position Manager
    try INonfungiblePositionManagerMinimal(positionManager).getReferrerConfig() returns (
        address referrer,
        uint24 feeRate
    ) {
        // Only extract fees if referrer is configured and fee rate > 0
        if (referrer != address(0) && feeRate > 0) {
            // Calculate referrer fees (feeRate in basis points, max 10000 = 100%)
            referrerFee0 = (totalFees0 * feeRate) / 10000;
            referrerFee1 = (totalFees1 * feeRate) / 10000;
            
            // Accumulate in position manager fee storage
            positionManagerFees[positionManager].token0 += uint128(referrerFee0);
            positionManagerFees[positionManager].token1 += uint128(referrerFee1);
            
            emit ReferrerFeeExtracted(positionManager, referrer, uint128(referrerFee0), uint128(referrerFee1));
        }
    } catch {
        // If getReferrerConfig() fails, skip referrer fee extraction
        referrerFee0 = 0;
        referrerFee1 = 0;
    }
}
```

**Key Features:**
- **Dynamic Lookup**: Real-time referrer configuration retrieval
- **Error Handling**: Graceful failure if Position Manager contract is invalid
- **Fee Calculation**: Basis points calculation (0-10000 = 0%-100%)
- **Safe Accumulation**: Overflow protection following existing patterns

### 4. Position Creation Enhancement

#### A. Modified Mint Function
```solidity
// MODIFIED: Enhanced mint function with position manager tracking
// File: contracts/UniswapV3Pool.sol
function mint(
    address recipient,
    int24 tickLower,
    int24 tickUpper,
    uint128 amount,
    bytes calldata data
) external override lock returns (uint256 amount0, uint256 amount1) {
    require(amount > 0);
    
    (, int256 amount0Int, int256 amount1Int) = _modifyPosition(
        ModifyPositionParams({
            owner: recipient,
            tickLower: tickLower,
            tickUpper: tickUpper,
            liquidityDelta: int256(amount).toInt128()
        })
    );
    
    // NEW: Track which Position Manager created this position
    bytes32 positionKey = PositionKey.compute(recipient, tickLower, tickUpper);
    positions[positionKey].positionManager = msg.sender;
    
    amount0 = uint256(amount0Int);
    amount1 = uint256(amount1Int);
    
    // Existing callback and balance validation logic...
    uint256 balance0Before;
    uint256 balance1Before;
    if (amount0 > 0) balance0Before = balance0();
    if (amount1 > 0) balance1Before = balance1();
    
    IUniswapV3MintCallback(msg.sender).uniswapV3MintCallback(amount0, amount1, data);
    
    // Balance validation...
    if (amount0 > 0) require(balance0Before.add(amount0) <= balance0(), 'M0');
    if (amount1 > 0) require(balance1Before.add(amount1) <= balance1(), 'M1');
    
    emit Mint(msg.sender, recipient, tickLower, tickUpper, amount, amount0, amount1);
}
```

**Key Changes:**
- **Position Manager Tracking**: Store `msg.sender` as the Position Manager that created the position
- **Authorization Setup**: Enables later authorization checks for position modifications
- **Minimal Impact**: Single storage write per position creation

#### B. Position Authorization in Modify Functions
```solidity
// MODIFIED: Enhanced burn function with position manager authorization
// File: contracts/UniswapV3Pool.sol
function burn(
    int24 tickLower,
    int24 tickUpper,
    uint128 amount
) external override lock returns (uint256 amount0, uint256 amount1) {
    // NEW: Verify position manager authorization
    bytes32 positionKey = PositionKey.compute(msg.sender, tickLower, tickUpper);
    require(
        positions[positionKey].positionManager == address(0) || 
        positions[positionKey].positionManager == msg.sender,
        "Unauthorized: only original position manager can modify position"
    );
    
    // Existing burn logic continues unchanged...
    (Position.Info storage position, int256 amount0Int, int256 amount1Int) = _modifyPosition(
        ModifyPositionParams({
            owner: msg.sender,
            tickLower: tickLower,
            tickUpper: tickUpper,
            liquidityDelta: -int256(amount).toInt128()
        })
    );
    
    amount0 = uint256(-amount0Int);
    amount1 = uint256(-amount1Int);
    
    emit Burn(msg.sender, tickLower, tickUpper, amount, amount0, amount1);
}
```

**Authorization Logic:**
- **Legacy Compatibility**: Positions without position manager (address(0)) can be modified by anyone
- **New Position Security**: Positions with position manager can only be modified by that manager
- **Cross-Contract Prevention**: Different Position Manager contracts cannot modify each other's positions

### 5. Position Manager Fee Collection

#### A. Direct Fee Collection Function
```solidity
// NEW: Position Manager fee collection (similar to collectProtocol)
// File: contracts/UniswapV3Pool.sol
function collectPositionManagerFee()
    external
    override
    lock
    returns (uint128 amount0, uint128 amount1)
{
    address positionManager = msg.sender;
    
    // Get accumulated fees for calling position manager
    amount0 = positionManagerFees[positionManager].token0;
    amount1 = positionManagerFees[positionManager].token1;
    
    // Get referrer address from calling Position Manager
    (address referrer, ) = INonfungiblePositionManagerMinimal(positionManager).getReferrerConfig();
    require(referrer != address(0), "PM: No referrer configured");
    
    // Transfer fees directly to referrer and clear storage
    if (amount0 > 0) {
        positionManagerFees[positionManager].token0 = 0;
        TransferHelper.safeTransfer(token0, referrer, amount0);
    }
    
    if (amount1 > 0) {
        positionManagerFees[positionManager].token1 = 0;
        TransferHelper.safeTransfer(token1, referrer, amount1);
    }
    
    emit CollectPositionManagerFee(positionManager, referrer, amount0, amount1);
}
```

#### B. Position Manager Fee Query Function
```solidity
// NEW: Query accumulated fees for position manager
// File: contracts/UniswapV3Pool.sol
function getPositionManagerFees(address positionManager)
    external
    view
    override
    returns (uint128 amount0, uint128 amount1)
{
    return (
        positionManagerFees[positionManager].token0,
        positionManagerFees[positionManager].token1
    );
}
```

**Collection Pattern:**
- **Caller Authorization**: Only Position Manager contracts can collect their own fees
- **Direct Transfer**: Fees sent directly to configured referrer (like protocol fees)
- **Storage Clearing**: Accumulated fees reset after successful collection
- **Error Handling**: Requires referrer to be configured before collection

### 6. Interface Extensions

#### A. Enhanced Pool Actions Interface
```solidity
// MODIFIED: Extended pool actions interface
// File: contracts/interfaces/pool/IUniswapV3PoolActions.sol
interface IUniswapV3PoolActions {
    // Existing functions...
    function mint(address recipient, int24 tickLower, int24 tickUpper, uint128 amount, bytes calldata data) external returns (uint256 amount0, uint256 amount1);
    function collect(address recipient, int24 tickLower, int24 tickUpper, uint128 amount0Requested, uint128 amount1Requested) external returns (uint128 amount0, uint128 amount1);
    function burn(int24 tickLower, int24 tickUpper, uint128 amount) external returns (uint256 amount0, uint256 amount1);
    
    // NEW: Position Manager fee collection
    function collectPositionManagerFee() external returns (uint128 amount0, uint128 amount1);
}
```

#### B. Enhanced Pool State Interface
```solidity
// MODIFIED: Extended pool state interface  
// File: contracts/interfaces/pool/IUniswapV3PoolState.sol
interface IUniswapV3PoolState {
    // Existing functions...
    function positions(bytes32 key) external view returns (uint128 _liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1);
    
    // NEW: Position Manager fee queries
    function getPositionManagerFees(address positionManager) external view returns (uint128 amount0, uint128 amount1);
    function positionManagerFees(address positionManager) external view returns (uint128 token0, uint128 token1);
}
```

#### C. Enhanced Pool Events Interface
```solidity
// MODIFIED: Extended pool events interface
// File: contracts/interfaces/pool/IUniswapV3PoolEvents.sol
interface IUniswapV3PoolEvents {
    // Existing events...
    event Mint(address sender, address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1);
    event Collect(address indexed owner, address recipient, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount0, uint128 amount1);
    
    // NEW: Position Manager referrer events
    event ReferrerFeeExtracted(address indexed positionManager, address indexed referrer, uint128 amount0, uint128 amount1);
    event CollectPositionManagerFee(address indexed positionManager, address indexed referrer, uint128 amount0, uint128 amount1);
}
```

### 7. Complete Integration Flow

#### Position Creation Flow
```solidity
// 1. User calls Position Manager mint
NonfungiblePositionManager.mint(params) 
    → calls pool.mint(recipient, tickLower, tickUpper, amount, data)
    
// 2. Pool stores position manager association
pool.mint() {
    // Standard mint logic...
    positions[positionKey].positionManager = msg.sender; // Store calling Position Manager
    emit Mint(...);
}
```

#### Fee Extraction Flow (During Swaps)
```solidity
// 1. Swap occurs, triggers position updates
pool.swap() → _updatePosition() for affected positions

// 2. Position fee calculation with referrer extraction  
_updatePosition() {
    // Calculate position fees...
    if (position.positionManager != address(0)) {
        (address referrer, uint24 feeRate) = INonfungiblePositionManagerMinimal(position.positionManager).getReferrerConfig();
        if (referrer != address(0) && feeRate > 0) {
            referrerFee0 = (positionFees0 * feeRate) / 10000;
            referrerFee1 = (positionFees1 * feeRate) / 10000;
            
            positionManagerFees[position.positionManager].token0 += referrerFee0;
            positionManagerFees[position.positionManager].token1 += referrerFee1;
            
            positionFees0 -= referrerFee0; // Reduce position owner fees
            positionFees1 -= referrerFee1;
        }
    }
    // Store reduced fees for position owner...
}
```

#### Fee Collection Flow
```solidity
// 1. Position Manager admin calls fee collection
positionManager.collectFeesFromPool(poolAddress)
    → calls pool.collectPositionManagerFee()

// 2. Pool transfers fees to referrer
pool.collectPositionManagerFee() {
    (address referrer, ) = INonfungiblePositionManagerMinimal(msg.sender).getReferrerConfig();
    // Transfer accumulated fees directly to referrer
    TransferHelper.safeTransfer(token0, referrer, amount0);
    TransferHelper.safeTransfer(token1, referrer, amount1);
    // Clear accumulated fees
    positionManagerFees[msg.sender] = PositionManagerFees(0, 0);
}
```

## Security Considerations

### 1. Position Manager Authorization
```solidity
// Prevent unauthorized position modifications
require(
    positions[positionKey].positionManager == address(0) || 
    positions[positionKey].positionManager == msg.sender,
    "Unauthorized position modification"
);
```

### 2. Fee Rate Validation
```solidity
// Position Manager enforces maximum fee rate
require(_feeRate <= 10000, 'Fee rate too high'); // Max 100%
```

### 3. External Call Safety
```solidity
// Safe external calls with try/catch
try INonfungiblePositionManagerMinimal(positionManager).getReferrerConfig() returns (
    address referrer,
    uint24 feeRate
) {
    // Extract referrer fees
} catch {
    // Skip referrer fee extraction if call fails
}
```

### 4. Reentrancy Protection
- All fee collection functions use existing `lock` modifier
- Follow established patterns from `collectProtocol()`
- No state changes after external transfers

### 5. Overflow Protection
```solidity
// Safe arithmetic for fee calculations
uint256 referrerFee = (totalFees * feeRate) / 10000;
positionManagerFees[positionManager].token0 += uint128(referrerFee);
```

## Gas Optimization Strategies

### 1. Storage Efficiency
- **Pack position manager address** with existing fields where possible
- **Minimal storage writes** during position creation (only positionManager field)
- **Batch fee accumulation** in existing fee calculation flows

### 2. Computation Efficiency
- **Skip referrer logic** when `positionManager == address(0)`
- **Cache referrer config** during multiple fee extractions
- **Single external call** per position update for referrer config

### 3. Pattern Reuse
- **Leverage existing fee calculation code** in `_updatePosition()`
- **Follow protocol fee patterns** for storage and collection
- **Reuse existing event emission patterns**

## Backwards Compatibility

### 1. Position Struct Compatibility
```solidity
// Legacy positions: positionManager = address(0)
// New positions: positionManager = calling Position Manager contract
// No impact on existing position owners
```

### 2. Function Signature Compatibility
- All existing function signatures remain unchanged
- New functions are additive only
- Existing position operations work identically for legacy positions

### 3. Fee Collection Compatibility
- Position owners collect fees normally (unchanged `collect()` function)
- Referrer fees automatically extracted during existing fee calculations
- No impact on existing LP fee collection flows

## Implementation Phases

### Phase 1: Core Storage and Tracking
1. **Position Struct Enhancement**: Add `positionManager` field
2. **Position Manager Fee Storage**: Add fee accumulation mapping
3. **Position Creation Tracking**: Modify `mint()` to store position manager

### Phase 2: Fee Extraction Integration
1. **Position Update Enhancement**: Modify `_updatePosition()` for referrer fee extraction
2. **External Call Interface**: Add Position Manager interface for referrer lookup
3. **Fee Calculation Logic**: Implement referrer fee extraction helper function

### Phase 3: Fee Collection Interface
1. **Collection Function**: Add `collectPositionManagerFee()` function
2. **Query Functions**: Add fee query and storage access functions
3. **Authorization Logic**: Add position manager authorization checks

### Phase 4: Interface and Event Extensions
1. **Interface Extensions**: Update pool action and state interfaces
2. **Event System**: Add referrer fee events for transparency
3. **Documentation**: Complete interface documentation and examples

## Testing Strategy

### 1. Unit Testing
- **Position creation** with position manager tracking
- **Fee extraction** during position updates
- **Fee collection** by position managers
- **Authorization checks** for position modifications

### 2. Integration Testing
- **Cross-contract communication** between pool and position manager
- **Multiple position managers** per pool
- **Dynamic referrer configuration** updates
- **Error handling** for invalid position manager contracts

### 3. Gas Analysis
- **Position creation overhead** (storing position manager)
- **Fee extraction overhead** during swaps
- **Collection function gas costs**
- **Comparison with protocol fee patterns**

### 4. Security Testing
- **Authorization bypass attempts**
- **Reentrancy attack scenarios**
- **Overflow/underflow in fee calculations**
- **Invalid external contract handling**

## Deployment Considerations

### 1. Contract Upgrade Strategy
- Pool contracts are immutable, requiring new deployments
- Position Manager contracts can be upgraded independently
- Gradual migration of liquidity to new pool contracts

### 2. Fee Rate Migration
- Legacy positions (without position manager) unaffected
- New positions automatically support referrer fees
- Position managers can update referrer config anytime

### 3. Multi-Contract Architecture
- Multiple Position Manager contracts can operate per pool
- Each Position Manager maintains separate fee accumulation
- Independent referrer configurations per Position Manager

## Conclusion

This implementation provides a robust, secure, and efficient system for Position Manager referrer fees that:

1. **Integrates seamlessly** with existing Uniswap V3 pool architecture
2. **Maintains backwards compatibility** with existing positions and integrations
3. **Follows established patterns** for fee collection and storage
4. **Provides strong security** through position manager authorization
5. **Minimizes gas overhead** by leveraging existing fee calculation flows
6. **Supports multiple position managers** with independent configurations

The two-level architecture ensures clean separation of concerns while enabling powerful economic incentives for position management services. The dynamic referrer lookup pattern provides flexibility for position managers to update their referrer configurations without affecting existing positions.