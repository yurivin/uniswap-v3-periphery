# UniswapV3Factory Swap Referrer Fee Implementation Plan

## Overview
This document outlines the changes required to the UniswapV3Factory contract to support swap referrer fee functionality. The factory will manage swap referrer fee configurations for pools, similar to how it currently manages protocol fees.

## Current Factory Structure Analysis

### Existing Functionality
The UniswapV3Factory contract currently:
- Manages pool creation and deployment
- Controls factory ownership
- Manages fee amount and tick spacing configurations
- Provides pool lookup functionality

### Current Owner Capabilities
The factory owner can:
- Change factory ownership (`setOwner`)
- Enable new fee amounts (`enableFeeAmount`)
- Set protocol fees on pools (via pool's `setFeeProtocol`)

## Proposed Swap Referrer Fee Management

### 1. Storage Additions

#### Add swap referrer fee configuration mapping
```solidity
/// @dev Mapping from pool address to swap referrer fee configuration
/// Uses same format as protocol fees: feeSwapReferrer0 + (feeSwapReferrer1 << 4)
mapping(address => uint8) public poolSwapReferrerFees;
```

#### Add default swap referrer fee configuration
```solidity
/// @dev Default swap referrer fee configuration for newly created pools
/// Uses same format as protocol fees: feeSwapReferrer0 + (feeSwapReferrer1 << 4)
/// Can be 0 (no swap referrer fees) or values between 4-20 (1/4 to 1/20 of swap fee)
uint8 public defaultSwapReferrerFee;
```

### 2. Interface Updates

#### Add to IUniswapV3Factory.sol
```solidity
/// @notice Emitted when the default swap referrer fee is changed
/// @param oldDefaultSwapReferrerFee The previous default swap referrer fee
/// @param newDefaultSwapReferrerFee The new default swap referrer fee
event DefaultSwapReferrerFeeChanged(uint8 oldDefaultSwapReferrerFee, uint8 newDefaultSwapReferrerFee);

/// @notice Emitted when a pool's swap referrer fee is set
/// @param pool The pool address
/// @param feeSwapReferrer0Old The previous swap referrer fee for token0
/// @param feeSwapReferrer1Old The previous swap referrer fee for token1
/// @param feeSwapReferrer0New The new swap referrer fee for token0
/// @param feeSwapReferrer1New The new swap referrer fee for token1
event PoolSwapReferrerFeeSet(
    address indexed pool,
    uint8 feeSwapReferrer0Old,
    uint8 feeSwapReferrer1Old,
    uint8 feeSwapReferrer0New,
    uint8 feeSwapReferrer1New
);

/// @notice Returns the default swap referrer fee for newly created pools
/// @return The default swap referrer fee configuration
function defaultSwapReferrerFee() external view returns (uint8);

/// @notice Returns the swap referrer fee configuration for a specific pool
/// @param pool The pool address
/// @return The swap referrer fee configuration (feeSwapReferrer0 + (feeSwapReferrer1 << 4))
function poolSwapReferrerFees(address pool) external view returns (uint8);

/// @notice Sets the default swap referrer fee for newly created pools
/// @dev Can only be called by the factory owner
/// @param _defaultSwapReferrerFee The new default swap referrer fee
function setDefaultSwapReferrerFee(uint8 _defaultSwapReferrerFee) external;

/// @notice Sets the swap referrer fee for a specific pool
/// @dev Can only be called by the factory owner
/// @param pool The pool address
/// @param feeSwapReferrer0 The swap referrer fee for token0 (0 or 4-20)
/// @param feeSwapReferrer1 The swap referrer fee for token1 (0 or 4-20)
function setPoolSwapReferrerFee(address pool, uint8 feeSwapReferrer0, uint8 feeSwapReferrer1) external;
```

### 3. Implementation Functions

#### setDefaultSwapReferrerFee function
```solidity
/// @inheritdoc IUniswapV3Factory
function setDefaultSwapReferrerFee(uint8 _defaultSwapReferrerFee) external override {
    require(msg.sender == owner, 'NOT_OWNER');
    require(
        _defaultSwapReferrerFee == 0 || (_defaultSwapReferrerFee >= 4 && _defaultSwapReferrerFee <= 20),
        'INVALID_SWAP_REFERRER_FEE'
    );
    
    uint8 oldDefaultSwapReferrerFee = defaultSwapReferrerFee;
    defaultSwapReferrerFee = _defaultSwapReferrerFee;
    
    emit DefaultSwapReferrerFeeChanged(oldDefaultSwapReferrerFee, _defaultSwapReferrerFee);
}
```

#### setPoolSwapReferrerFee function
```solidity
/// @inheritdoc IUniswapV3Factory
function setPoolSwapReferrerFee(
    address pool,
    uint8 feeSwapReferrer0,
    uint8 feeSwapReferrer1
) external override {
    require(msg.sender == owner, 'NOT_OWNER');
    require(pool != address(0), 'INVALID_POOL');
    require(
        (feeSwapReferrer0 == 0 || (feeSwapReferrer0 >= 4 && feeSwapReferrer0 <= 20)) &&
        (feeSwapReferrer1 == 0 || (feeSwapReferrer1 >= 4 && feeSwapReferrer1 <= 20)),
        'INVALID_SWAP_REFERRER_FEE'
    );
    
    uint8 currentFee = poolSwapReferrerFees[pool];
    uint8 feeSwapReferrer0Old = currentFee % 16;
    uint8 feeSwapReferrer1Old = currentFee >> 4;
    
    poolSwapReferrerFees[pool] = feeSwapReferrer0 + (feeSwapReferrer1 << 4);
    
    // Update the pool's swap referrer fee configuration
    IUniswapV3Pool(pool).setFeeSwapReferrer(feeSwapReferrer0, feeSwapReferrer1);
    
    emit PoolSwapReferrerFeeSet(pool, feeSwapReferrer0Old, feeSwapReferrer1Old, feeSwapReferrer0, feeSwapReferrer1);
}
```

#### Helper function to get swap referrer fee breakdown
```solidity
/// @notice Returns the swap referrer fee breakdown for a specific pool
/// @param pool The pool address
/// @return feeSwapReferrer0 The swap referrer fee for token0
/// @return feeSwapReferrer1 The swap referrer fee for token1
function getPoolSwapReferrerFees(address pool) external view returns (uint8 feeSwapReferrer0, uint8 feeSwapReferrer1) {
    uint8 fees = poolSwapReferrerFees[pool];
    feeSwapReferrer0 = fees % 16;
    feeSwapReferrer1 = fees >> 4;
}
```

### 4. Pool Creation Integration

#### Modify createPool function
```solidity
/// @inheritdoc IUniswapV3Factory
function createPool(
    address tokenA,
    address tokenB,
    uint24 fee
) external override noDelegateCall returns (address pool) {
    require(tokenA != tokenB);
    (address token0, address token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
    require(token0 != address(0));
    int24 tickSpacing = feeAmountTickSpacing[fee];
    require(tickSpacing != 0);
    require(getPool[token0][token1][fee] == address(0));
    
    pool = deploy(address(this), token0, token1, fee, tickSpacing);
    getPool[token0][token1][fee] = pool;
    getPool[token1][token0][fee] = pool;
    
    // Set default swap referrer fee for the new pool
    if (defaultSwapReferrerFee > 0) {
        poolSwapReferrerFees[pool] = defaultSwapReferrerFee;
        uint8 feeSwapReferrer0 = defaultSwapReferrerFee % 16;
        uint8 feeSwapReferrer1 = defaultSwapReferrerFee >> 4;
        IUniswapV3Pool(pool).setFeeSwapReferrer(feeSwapReferrer0, feeSwapReferrer1);
    }
    
    emit PoolCreated(token0, token1, fee, tickSpacing, pool);
}
```

### 5. Batch Operations Support

#### Batch set referrer fees for multiple pools
```solidity
/// @notice Sets swap referrer fees for multiple pools in a single transaction
/// @dev Can only be called by the factory owner
/// @param pools Array of pool addresses
/// @param feeSwapReferrer0s Array of swap referrer fees for token0
/// @param feeSwapReferrer1s Array of swap referrer fees for token1
function batchSetPoolSwapReferrerFees(
    address[] calldata pools,
    uint8[] calldata feeSwapReferrer0s,
    uint8[] calldata feeSwapReferrer1s
) external {
    require(msg.sender == owner, 'NOT_OWNER');
    require(
        pools.length == feeSwapReferrer0s.length && pools.length == feeSwapReferrer1s.length,
        'ARRAY_LENGTH_MISMATCH'
    );
    
    for (uint256 i = 0; i < pools.length; i++) {
        setPoolSwapReferrerFee(pools[i], feeSwapReferrer0s[i], feeSwapReferrer1s[i]);
    }
}
```

### 6. Migration and Upgrade Support

#### Initialize referrer fees for existing pools
```solidity
/// @notice Initializes swap referrer fees for existing pools
/// @dev One-time function to set swap referrer fees for pools created before this upgrade
/// @param pools Array of existing pool addresses
/// @param swapReferrerFee The swap referrer fee to set for all pools
function initializeExistingPoolSwapReferrerFees(
    address[] calldata pools,
    uint8 swapReferrerFee
) external {
    require(msg.sender == owner, 'NOT_OWNER');
    require(swapReferrerFee == 0 || (swapReferrerFee >= 4 && swapReferrerFee <= 20), 'INVALID_SWAP_REFERRER_FEE');
    
    for (uint256 i = 0; i < pools.length; i++) {
        address pool = pools[i];
        require(pool != address(0), 'INVALID_POOL');
        
        // Only initialize if not already set
        if (poolSwapReferrerFees[pool] == 0) {
            poolSwapReferrerFees[pool] = swapReferrerFee + (swapReferrerFee << 4);
            IUniswapV3Pool(pool).setFeeSwapReferrer(swapReferrerFee, swapReferrerFee);
            
            emit PoolSwapReferrerFeeSet(pool, 0, 0, swapReferrerFee, swapReferrerFee);
        }
    }
}
```

## Implementation Steps

**Note**: Implementation uses Factory Extension Pattern to overcome 24KB contract size limit.

### Phase 1: Interface Updates ✅ **IMPLEMENTED**
1. ✅ Add new events to `IUniswapV3FactoryExtensions.sol`
2. ✅ Add new functions to `IUniswapV3FactoryExtensions.sol`
3. ✅ Update interface documentation

**Implementation Location**: `contracts/interfaces/IUniswapV3FactoryExtensions.sol`

### Phase 2: Storage Implementation ✅ **IMPLEMENTED**
1. ✅ Add `poolSwapReferrerFees` mapping
2. ✅ Add `defaultSwapReferrerFee` variable
3. ✅ Update constructor if needed

**Implementation Location**: `contracts/UniswapV3FactoryExtensions.sol`

### Phase 3: Core Functions ✅ **IMPLEMENTED**
1. ✅ Implement `setDefaultSwapReferrerFee()`
2. ✅ Implement `setPoolSwapReferrerFee()`
3. ✅ Implement `getPoolSwapReferrerFees()` helper (via interface getter)
4. ✅ Add input validation and access control

**Implementation Location**: `contracts/UniswapV3FactoryExtensions.sol`

### Phase 4: Pool Creation Integration ⏳ **PENDING**
1. ❌ Modify `createPool()` to set default swap referrer fees
2. ❌ Ensure proper initialization of new pools

**Note**: Requires pool contract modifications to accept swap referrer fees.

### Phase 5: Batch Operations ⏳ **PENDING**
1. ❌ Implement `batchSetPoolSwapReferrerFees()`
2. ❌ Implement `initializeExistingPoolSwapReferrerFees()`

**Note**: Can be added to Extensions contract when needed.

### Phase 6: Testing and Validation ✅ **IMPLEMENTED**
1. ✅ Unit tests for all new functions
2. ❌ Integration tests with pool creation
3. ✅ Access control tests
4. ✅ Edge case validation

**Implementation Location**: `test/FactoryExtensionArchitecture.spec.ts`

## Security Considerations

### 1. Access Control
- Only factory owner can set swap referrer fees
- Proper validation of owner permissions
- Consider multi-sig requirements for production

### 2. Input Validation
- Swap referrer fees must be 0 or between 4-20 (1/4 to 1/20 of swap fee)
- Pool addresses must be valid
- Array lengths must match for batch operations

### 3. State Management
- Proper storage of swap referrer fee configurations
- Consistent state between factory and pools
- Handle edge cases for uninitialized pools

### 4. Upgrade Safety
- Backwards compatibility for existing pools
- Safe migration path for swap referrer fee configuration
- Proper event emission for tracking changes

## Gas Optimization

### 1. Storage Efficiency
- Pack swap referrer fees into single uint8 (4 bits each)
- Use mappings for efficient lookups
- Minimize storage operations

### 2. Batch Operations
- Support batch setting to reduce transaction costs
- Optimize loops for gas efficiency
- Consider gas limits for large batches

### 3. View Functions
- Efficient getter functions
- Minimal external calls
- Optimized data structures

## Integration with Pool Contract

### Pool Interface Requirements
The pool contract must implement:
```solidity
function setFeeSwapReferrer(uint8 feeSwapReferrer0, uint8 feeSwapReferrer1) external;
```

### Factory-Pool Communication
- Factory calls pool's `setFeeSwapReferrer()` during configuration
- Pool validates that caller is factory
- Proper error handling for failed calls

## Configuration Examples

### Example 1: Set 5% swap referrer fee (1/20 of swap fee)
```solidity
factory.setDefaultSwapReferrerFee(20); // 1/20 = 5%
```

### Example 2: Set different swap referrer fees for token0 and token1
```solidity
factory.setPoolSwapReferrerFee(poolAddress, 10, 20); // 1/10 and 1/20
```

### Example 3: Disable swap referrer fees
```solidity
factory.setPoolSwapReferrerFee(poolAddress, 0, 0); // No swap referrer fees
```

## Backward Compatibility

- Existing pools continue to work without swap referrer fees
- New pools can be created with default swap referrer fees
- Migration tools provided for existing pool upgrades
- No breaking changes to existing interfaces

## Monitoring and Analytics

### Events for Tracking
- `DefaultSwapReferrerFeeChanged`: Track default fee changes
- `PoolSwapReferrerFeeSet`: Track individual pool configurations
- Integration with existing pool events

### Query Functions
- `poolSwapReferrerFees()`: Get current pool configuration
- `getPoolSwapReferrerFees()`: Get breakdown of fees
- `defaultSwapReferrerFee()`: Get default configuration

## Conclusion

This implementation plan provides a comprehensive approach to adding swap referrer fee management to the UniswapV3Factory contract. The design maintains consistency with existing protocol fee patterns while providing flexibility for different swap referrer fee configurations across pools.

The factory-based approach ensures:
- Centralized management of swap referrer fees
- Consistent configuration across pools
- Easy migration and upgrade paths
- Proper access control and validation
- Gas-efficient operations