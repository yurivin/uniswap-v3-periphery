# Position Manager Referrer Fee Implementation Plan

## Overview
This document outlines the implementation plan for adding position manager referrer fee functionality to the Uniswap V3 NonFungiblePositionManager contract. The system extracts referrer fees during swap fee calculations (like protocol fees) and provides economic incentives for position management operations.

## Architecture Summary

### Core Components
1. **Swap-Time Fee Extraction**: Extract position manager referrer fees during swap fee calculations (similar to protocol fees)
2. **Position Manager Tracking**: Each position tracks which manager created it (immutable)
3. **Self-Managed Configuration**: Position managers configure their own referrer addresses and fee rates
4. **Accumulate-Then-Collect**: Referrer fees accumulate and are collected separately via new function
5. **Unchanged LP Flow**: `collect()` function remains completely unchanged for position owners

### Key Features
- **Fee Extraction During Swaps**: Extract referrer fees when swap fees are calculated (like protocol fees)
- **Accumulate-Then-Collect Pattern**: Referrer fees accumulate and are collected separately (like SwapRouter referrer system)
- **Self-Managed Configuration**: Position managers set their own referrer addresses and fee rates (no factory whitelist)
- **Unchanged collect() Function**: Position owners collect LP fees normally, completely unchanged
- **Gas Efficient**: Minimal overhead, follows existing protocol fee patterns
- **Backwards Compatible**: Existing positions work unchanged, new positions can opt into referrer fees

## Implementation Components

### 1. Enhanced Position Struct

```solidity
struct Position {
    uint96 nonce;
    address operator;
    uint80 poolId;
    int24 tickLower;
    int24 tickUpper;
    uint128 liquidity;
    uint256 feeGrowthInside0LastX128;
    uint256 feeGrowthInside1LastX128;
    uint128 tokensOwed0;
    uint128 tokensOwed1;
    address positionManager;     // NEW: Position manager (set once at creation, immutable)
    uint24 referrerFeeRate;      // NEW: Fee rate in basis points (0-10000, 100% max)
}
```

### 2. Position Manager Configuration

```solidity
// Self-managed configuration (no factory whitelist)
mapping(address => address) public positionManagerReferrers;
mapping(address => uint24) public positionManagerReferrerFeeRates;

/// @notice Set referrer address for position manager
/// @param referrer Address to receive referrer fees
function setPositionManagerReferrer(address referrer) external;

/// @notice Set referrer fee rate for position manager  
/// @param feeRate Fee rate in basis points (0-10000, max 100%)
function setPositionManagerReferrerFeeRate(uint24 feeRate) external {
    require(feeRate <= 10000, "Fee rate exceeds 100%");
    // Implementation...
}

/// @notice Get position manager configuration
/// @param positionManager Position manager address
/// @return referrer Referrer address
/// @return feeRate Fee rate in basis points
function getPositionManagerConfig(address positionManager) 
    external 
    view 
    returns (address referrer, uint24 feeRate);
```

### 3. Fee Accumulation System

```solidity
// Storage for accumulated position manager referrer fees
mapping(address => mapping(address => uint256)) public positionManagerReferrerFees;

// Accumulation happens during swap fee calculations (in pool contracts)
// Similar to how protocol fees are extracted and accumulated
```

### 4. Fee Collection Functions

```solidity
/// @notice Collect accumulated referrer fees for position manager
/// @param token Token address to collect fees for
/// @return amount Amount collected
function collectPositionManagerReferrerFees(address token) 
    external 
    returns (uint256 amount);

/// @notice Collect accumulated referrer fees for multiple tokens
/// @param tokens Array of token addresses
/// @return amounts Array of amounts collected
function collectPositionManagerReferrerFeesMultiple(address[] calldata tokens)
    external
    returns (uint256[] memory amounts);

/// @notice Get accumulated fees for position manager
/// @param positionManager Position manager address
/// @param token Token address
/// @return Accumulated fee amount
function getPositionManagerReferrerFees(address positionManager, address token)
    external
    view
    returns (uint256);
```

### 5. Enhanced Mint Function

```solidity
/// @inheritdoc INonfungiblePositionManager
function mint(MintParams calldata params)
    external
    payable
    override
    checkDeadline(params.deadline)
    returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)
{
    // Existing mint logic...
    
    // NEW: Set position manager and referrer fee rate
    address positionManager = msg.sender;
    uint24 referrerFeeRate = positionManagerReferrerFeeRates[positionManager];
    
    _positions[tokenId] = Position({
        nonce: uint96(tokenId),
        operator: address(0),
        poolId: poolId,
        tickLower: params.tickLower,
        tickUpper: params.tickUpper,
        liquidity: liquidity,
        feeGrowthInside0LastX128: 0,
        feeGrowthInside1LastX128: 0,
        tokensOwed0: 0,
        tokensOwed1: 0,
        positionManager: positionManager,        // IMMUTABLE after creation
        referrerFeeRate: referrerFeeRate         // Set from position manager config
    });
    
    // Emit tracking event
    emit PositionCreated(tokenId, positionManager, referrerFeeRate);
}
```

### 6. Pool Contract Integration

Fee extraction occurs in pool contracts during swap fee calculations:

```solidity
// In UniswapV3Pool.sol - during swap fee calculation
function _updatePosition(
    address owner,
    int24 tickLower,
    int24 tickUpper,
    int128 liquidityDelta,
    int256 feeGrowthInside0X128,
    int256 feeGrowthInside1X128
) private returns (bytes32 positionKey) {
    // Existing logic...
    
    // NEW: Extract position manager referrer fees (similar to protocol fees)
    if (/* position has referrer fee rate > 0 */) {
        // Extract referrer fees from position fees
        // Accumulate in NonFungiblePositionManager contract
    }
}
```

## Events

```solidity
event PositionCreated(
    uint256 indexed tokenId,
    address indexed positionManager,
    uint24 referrerFeeRate
);

event PositionManagerReferrerSet(
    address indexed positionManager,
    address indexed referrer
);

event PositionManagerReferrerFeeRateSet(
    address indexed positionManager,
    uint24 feeRate
);

event PositionManagerReferrerFeesCollected(
    address indexed positionManager,
    address indexed token,
    uint256 amount
);

event PositionManagerReferrerFeesCollectedMultiple(
    address indexed positionManager,
    address[] tokens,
    uint256[] amounts
);
```

## Implementation Phases

### Phase 1: Core Infrastructure (Tasks 1-4)

**Task 1: Enhance Position Struct**
- Add `positionManager` field (address, immutable after creation)
- Add `referrerFeeRate` field (uint24, 0-10000 basis points for 0-100%)
- Optimize storage packing to minimize gas costs
- Update Position struct documentation

**Task 2: Position Manager Configuration Functions**
- Implement `setPositionManagerReferrer(address referrer)` function
- Implement `setPositionManagerReferrerFeeRate(uint24 feeRate)` function with validation
- Add validation: `require(feeRate <= 10000, "Fee rate exceeds 100%")`
- Restrict access to position manager only (msg.sender validation)

**Task 3: Fee Accumulation Storage**
- Implement `mapping(address => mapping(address => uint256)) positionManagerReferrerFees`
- Storage pattern: positionManager => token => accumulated amount
- Follow existing fee storage patterns for consistency
- Initialize storage mappings properly

**Task 4: Enhanced Mint Function**
- Read position manager configuration during mint
- Set `position.positionManager = msg.sender` (immutable)
- Set `position.referrerFeeRate` from manager's configuration
- Emit `PositionCreated` event with tracking data

### Phase 2: Fee Collection System (Tasks 5-8)

**Task 5: Single Token Fee Collection**
- Implement `collectPositionManagerReferrerFees(address token)` function
- Validate caller permissions and accumulated fee amounts
- Transfer fees to position manager (msg.sender)
- Clear accumulated fees after successful transfer
- Follow secure transfer patterns

**Task 6: Batch Fee Collection**
- Implement `collectPositionManagerReferrerFeesMultiple(address[] tokens)` function
- Optimize gas usage for multiple token collections
- Return array of collected amounts
- Handle partial failures gracefully

**Task 7: View Functions**
- Implement `getPositionManagerConfig(address manager)` returns (address referrer, uint24 feeRate)
- Implement `getPositionManagerReferrerFees(address manager, address token)` returns accumulated fees
- Add helper functions for position manager queries
- Ensure efficient gas usage for read operations

**Task 8: Event System**
- Implement `PositionCreated(tokenId, positionManager, referrerFeeRate)` event
- Implement `PositionManagerReferrerSet(positionManager, referrer)` event  
- Implement `PositionManagerReferrerFeeRateSet(positionManager, feeRate)` event
- Implement `PositionManagerReferrerFeesCollected(positionManager, token, amount)` event
- Implement `PositionManagerReferrerFeesCollectedMultiple(positionManager, tokens[], amounts[])` event

### Phase 3: Pool Integration (Tasks 9-11)

**Task 9: Pool Contract Fee Extraction**
- Modify pool contract swap fee calculations
- Extract position manager referrer fees during swap processing
- Calculate fees based on position's referrerFeeRate
- Integrate with existing protocol fee extraction patterns

**Task 10: Fee Growth Tracking Integration**
- Integrate with existing `feeGrowthGlobal0X128` mechanisms
- Ensure proper fee distribution after referrer fee extraction
- Maintain compatibility with existing fee growth calculations
- Preserve LP fee calculation accuracy

**Task 11: Fee Accumulation During Swaps**
- Implement fee accumulation in NonFungiblePositionManager contract
- Call accumulation from pool contracts during swaps
- Ensure proper token routing and accumulation
- Handle multiple positions affected by single swap

### Phase 4: Testing and Optimization (Tasks 12-15)

**Task 12: Comprehensive Unit Testing**
- Test position manager configuration functions
- Test position creation with referrer tracking
- Test fee collection (single and batch)
- Test edge cases and error conditions
- Test 0% and 100% fee rate scenarios

**Task 13: Integration Testing**
- Test integration with existing position management (mint, increase, decrease, collect, burn)
- Test interaction with protocol fees and SwapRouter referrer fees
- Test gas costs and performance impact
- Ensure backwards compatibility

**Task 14: Gas Optimization**
- Analyze storage packing efficiency
- Optimize batch operations
- Implement lazy loading where appropriate
- Benchmark against existing operations
- Target <25k gas overhead per operation

**Task 15: Security and Audit Preparation**
- Security review of all new functions
- Reentrancy analysis and protection
- Access control validation
- Fee calculation accuracy verification
- Prepare comprehensive audit documentation

## Gas Optimization Strategies

1. **Storage Packing**: Pack new fields efficiently in Position struct
2. **Batch Operations**: Support batch fee collection for gas efficiency
3. **Existing Patterns**: Leverage existing fee calculation mechanisms
4. **Minimal Overhead**: Only add computation when referrer fees are configured

## Security Considerations

1. **Fee Rate Limits**: Maximum 100% referrer fee rate (10000 basis points)
2. **Self-Management**: Position managers control their own configuration
3. **Immutable Associations**: Position manager cannot be changed after creation
4. **Reentrancy Protection**: Use existing patterns from collect() function
5. **Access Control**: Proper validation in configuration functions

## Backwards Compatibility

1. **Existing Positions**: Continue to work without referrer fees (default 0% rate)
2. **Interface Compatibility**: All existing functions maintain same signatures
3. **Optional Features**: Referrer fees are opt-in via position manager configuration
4. **Migration**: Smooth transition for existing position managers

## Success Metrics

1. **Adoption**: Number of position managers implementing referrer fees
2. **Volume**: Value of positions created with referrer fees
3. **Efficiency**: Gas cost impact on position creation and management
4. **Security**: No security incidents or fee calculation errors

## Conclusion

This implementation provides a clean, efficient system for position manager referrer fees that:
- Follows existing Uniswap protocol patterns (protocol fees, SwapRouter referrer fees)
- Maintains backwards compatibility with existing integrations
- Provides economic incentives for position management services
- Minimizes gas overhead and complexity
- Enables self-governance without central control mechanisms

The system is designed to integrate seamlessly with existing Uniswap V3 infrastructure while providing new economic opportunities for position managers and referrers.