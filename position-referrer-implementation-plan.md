# Position Manager Referrer Fee Implementation Plan

## Overview
This document outlines the implementation plan for adding position manager referrer fee functionality to the Uniswap V3 NonFungiblePositionManager contract. The system extracts referrer fees during swap fee calculations (like protocol fees) and provides economic incentives for position management operations.

## Architecture Summary

### Core Components
1. **Hybrid Storage Pattern**: Position manager referrer fees stored in pools like protocol fees (multiple managers per pool)
2. **Position Fee Integration**: Extract referrer fees during existing position fee calculations (no separate functions)
3. **Position Manager Tracking**: Each position tracks which manager created it (immutable)
4. **Self-Managed Configuration**: Position managers configure their own referrer addresses and fee rates
5. **Direct Pool Collection**: Position managers collect directly from pools like `collectProtocol()`
6. **Unchanged LP Flow**: `collect()` function remains completely unchanged for position owners

### Key Features
- **Hybrid Pattern**: Combines protocol fee storage with position fee calculation integration
- **Pool-Centric Storage**: Multiple position managers store fees per pool (like protocol fees)
- **Position Fee Integration**: Referrer fees extracted during existing position fee calculations
- **Direct Collection**: Position managers collect from pools like `collectProtocol()`
- **Self-Managed Configuration**: Position managers set their own referrer addresses and fee rates
- **Position Manager Authorization**: Only the original position manager can modify their positions
- **Unchanged collect() Function**: Position owners collect LP fees normally, completely unchanged
- **Gas Efficient**: No separate fee extraction functions, integrates into existing calculations
- **Backwards Compatible**: Existing positions work unchanged, new positions can opt into referrer fees

## Implementation Approach

### Function Modification Strategy

**Update Existing Functions In Place:**
- `mint()` - Enhance existing function to add position manager tracking
- `_updatePosition()` - Integrate referrer fee extraction into existing position fee calculations
- Do NOT create duplicate functions, modify the existing logic directly

**Create New Functions:**
- `collectPositionManagerFee()` - New functionality for position managers to collect fees from pools
- Configuration functions (`setPositionManagerReferrer()`, etc.) - New functionality

**Keep Unchanged:**
- `collect()` - Existing position owner fee collection remains completely unchanged
- All other existing LP functionality stays identical

### Key Principles:
1. **Enhance, don't duplicate** - Update existing functions to add new capabilities
2. **Separate concerns** - New functionality gets new functions
3. **Preserve existing behavior** - LP functions work exactly as before
4. **Position manager authorization** - Only original position manager can modify their positions

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
    address positionManager;     // NEW: Position manager (set once at creation, immutable, controls position)
    uint24 referrerFeeRate;      // NEW: Fee rate in basis points (0-10000, 100% max)
}
```

### 2. Position Manager Configuration

```solidity
// Self-managed configuration (no factory whitelist)
mapping(address => address) public positionManagerReferrers;
mapping(address => uint24) public positionManagerFeeRates;

/// @notice Set referrer address for position manager
/// @param referrer Address to receive referrer fees
function setPositionManagerReferrer(address referrer) external;

/// @notice Set referrer fee rate for position manager  
/// @param feeRate Fee rate in basis points (0-10000, max 100%)
function setPositionManagerFeeRate(uint24 feeRate) external {
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

### 3. Hybrid Fee Storage and Calculation

```solidity
// In UniswapV3Pool.sol - Storage like protocol fees, multiple managers per pool
struct PositionManagerFees {
    uint128 token0;
    uint128 token1;
}

mapping(address => PositionManagerFees) public positionManagerFees;

// Fee extraction integrated into existing position fee calculations
// No separate extraction functions - calculated where position fees are calculated
// Position managers collect directly from pools (like collectProtocol)
```

### 4. Pool Fee Collection Function

```solidity
// In UniswapV3Pool.sol - Position managers collect directly from pools
/// @notice Collect accumulated referrer fees for position manager
/// @return amount0 Token0 amount collected
/// @return amount1 Token1 amount collected
function collectPositionManagerFee()
    external
    returns (uint128 amount0, uint128 amount1) {
    address positionManager = msg.sender;
    
    amount0 = positionManagerFees[positionManager].token0;
    amount1 = positionManagerFees[positionManager].token1;
    
    // Get referrer address from periphery
    address referrer = INonfungiblePositionManager(nftContract).positionManagerReferrers(positionManager);
    require(referrer != address(0), "No referrer configured");
    
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

/// @notice Get accumulated fees for calling position manager
/// @return amount0 Token0 accumulated amount
/// @return amount1 Token1 accumulated amount
function getPositionManagerFee()
    external
    view
    returns (uint128 amount0, uint128 amount1) {
    address positionManager = msg.sender;
    return (positionManagerFees[positionManager].token0, positionManagerFees[positionManager].token1);
}
```

### 5. Updated Mint Function (Modify Existing)

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
    uint24 referrerFeeRate = positionManagerFeeRates[positionManager];
    
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

### 6. Pool Contract Integration (Modify Existing _updatePosition)

Fee extraction integrated into existing position fee calculations by modifying `_updatePosition()` in place:

```solidity
// In UniswapV3Pool.sol - integrated into existing _updatePosition() function
function _updatePosition(
    address owner,
    int24 tickLower,
    int24 tickUpper,
    int128 liquidityDelta,
    int256 feeGrowthInside0X128,
    int256 feeGrowthInside1X128
) private returns (bytes32 positionKey) {
    Position.Info storage _self = positions[positionKey];
    
    // Existing position fee calculations...
    uint256 tokensOwed0 = FullMath.mulDiv(
        feeGrowthInside0X128 - _self.feeGrowthInside0LastX128,
        _self.liquidity,
        FixedPoint128.Q128
    );
    uint256 tokensOwed1 = FullMath.mulDiv(
        feeGrowthInside1X128 - _self.feeGrowthInside1LastX128,
        _self.liquidity,
        FixedPoint128.Q128
    );
    
    // NEW: Extract position manager referrer fees during position fee calculation
    if (_self.positionManager != address(0) && _self.referrerFeeRate > 0) {
        uint256 referrerFee0 = (tokensOwed0 * _self.referrerFeeRate) / 10000;
        uint256 referrerFee1 = (tokensOwed1 * _self.referrerFeeRate) / 10000;
        
        // Accumulate in pool storage (like protocol fees)
        positionManagerFees[_self.positionManager].token0 += referrerFee0;
        positionManagerFees[_self.positionManager].token1 += referrerFee1;
        
        // Reduce position owner fees
        tokensOwed0 -= referrerFee0;
        tokensOwed1 -= referrerFee1;
    }
    
    // Existing logic continues with adjusted tokensOwed amounts...
    _self.tokensOwed0 += tokensOwed0;
    _self.tokensOwed1 += tokensOwed1;
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

event PositionManagerFeeRateSet(
    address indexed positionManager,
    uint24 feeRate
);

event PositionManagerFeeCollected(
    address indexed positionManager,
    address indexed token,
    uint256 amount
);

event PositionManagerFeeCollectedMultiple(
    address indexed positionManager,
    address[] tokens,
    uint256[] amounts
);
```

## Implementation Phases

### Phase 1: Periphery Infrastructure (Tasks 1-5)
**Repository: uniswap-v3-periphery**

**Task 1: Enhance Position Struct [PERIPHERY]**
- **Contract**: `NonfungiblePositionManager.sol`
- Add `positionManager` field (address, immutable after creation)
- Add `referrerFeeRate` field (uint24, 0-10000 basis points for 0-100%)
- Optimize storage packing to minimize gas costs
- Update Position struct documentation

**Task 2: Position Manager Configuration and Authorization [PERIPHERY]**
- **Contract**: `NonfungiblePositionManager.sol`
- Add `onlyPositionManager(uint256 tokenId)` modifier for position access control
- Implement `setPositionManagerReferrer(address referrer)` function (one referrer per position manager)
- Implement `setPositionManagerFeeRate(uint24 feeRate)` function with validation (one fee rate per position manager)
- Add validation: `require(feeRate <= 10000, "Fee rate exceeds 100%")`
- Restrict access to position manager only (msg.sender validation)
- Apply authorization to position modification functions (increaseLiquidity, decreaseLiquidity, etc.)

**Task 3: Position Manager Configuration Storage [PERIPHERY]**
- **Contract**: `NonfungiblePositionManager.sol`
- Implement `mapping(address => address) positionManagerReferrers` (one referrer per position manager)
- Implement `mapping(address => uint24) positionManagerFeeRates` (one fee rate per position manager)
- Follow existing mapping patterns for consistency
- Initialize storage mappings properly

**Task 4: Update Existing Mint Function [PERIPHERY]**
- **Contract**: `NonfungiblePositionManager.sol`
- **Approach**: Modify existing `mint()` function in place (do not create duplicate)
- Read position manager configuration during mint
- Set `position.positionManager = msg.sender` (immutable)
- Set `position.referrerFeeRate` from manager's configuration
- Emit `PositionCreated` event with tracking data

### Phase 2: Periphery View Functions and Events (Tasks 5-7)
**Repository: uniswap-v3-periphery**

**Task 5: Pool Integration Interface [PERIPHERY]**
- **Contract**: `NonfungiblePositionManager.sol`
- Provide public view functions for pool contracts to access referrer configuration
- Ensure `positionManagerReferrers` and `positionManagerFeeRates` are publicly accessible
- Add helper functions for position manager queries if needed

**Task 6: View Functions [PERIPHERY]**
- **Contract**: `NonfungiblePositionManager.sol`
- Implement `getPositionManagerConfig(address manager)` returns (address referrer, uint24 feeRate)
- Add helper functions for position manager queries
- Ensure efficient gas usage for read operations

**Task 7: Event System [PERIPHERY]**
- **Contract**: `NonfungiblePositionManager.sol`
- Implement `PositionCreated(tokenId, positionManager, referrerFeeRate)` event
- Implement `PositionManagerReferrerSet(positionManager, referrer)` event  
- Implement `PositionManagerFeeRateSet(positionManager, feeRate)` event

### Phase 3: Core Pool Integration (Tasks 8-10)
**Repository: uniswap-v3-core**

**Task 8: Pool Fee Storage [CORE]**
- **Contract**: `UniswapV3Pool.sol`
- Add `mapping(address => PositionManagerFees) positionManagerFees` storage
- Define `PositionManagerFees` struct with token0 and token1 amounts
- Follow existing protocol fee storage patterns
- Initialize storage mappings properly

**Task 9: Update Existing Position Fee Calculation [CORE]**
- **Contract**: `UniswapV3Pool.sol`
- **Approach**: Modify existing `_updatePosition()` function in place (do not create duplicate)
- Integrate referrer fee extraction into existing position fee calculations
- Calculate referrer fees during position fee calculations (no separate functions)
- Extract fees based on position's `positionManager` and `referrerFeeRate`
- Accumulate extracted fees in pool's `positionManagerFees` mapping
- Reduce position owner fees by referrer fee amount

**Task 10: Pool Fee Collection Function [CORE]**
- **Contract**: `UniswapV3Pool.sol`
- Add `collectPositionManagerFee()` function (no parameters, use msg.sender)
- Follow `collectProtocol()` pattern exactly
- Access periphery contract to get referrer address
- Transfer fees directly to configured referrer
- Clear accumulated fees after successful transfer

### Phase 4: Periphery Testing (Tasks 11-12)
**Repository: uniswap-v3-periphery**

**Task 11: Periphery Unit Testing [PERIPHERY]**
- **Test Files**: `test/PositionManagerReferrer.spec.ts`
- Test position manager configuration functions
- Test position creation with referrer tracking
- Test position manager authorization (only original manager can modify positions)
- Test unauthorized access prevention (other managers cannot modify positions)
- Test fee collection (single and batch)
- Test edge cases and error conditions
- Test 0% and 100% fee rate scenarios
- Test periphery-only functionality

**Task 12: Periphery Gas Optimization [PERIPHERY]**
- **Contracts**: `NonfungiblePositionManager.sol`
- Analyze storage packing efficiency in Position struct
- Optimize batch operations in fee collection
- Implement lazy loading where appropriate
- Benchmark against existing operations
- Target <25k gas overhead per operation

### Phase 5: Core Testing (Tasks 13-14)
**Repository: uniswap-v3-core**

**Task 13: Core Pool Testing [CORE]**
- **Test Files**: Core pool integration tests
- Test pool contract fee extraction during swaps
- Test fee growth tracking modifications
- Test external calls to periphery contracts
- Test core-only functionality
- Benchmark swap gas costs

**Task 14: Core Gas Optimization [CORE]**
- **Contracts**: `UniswapV3Pool.sol`
- Minimize external calls between core and periphery
- Optimize fee extraction calculations
- Analyze impact on swap gas costs
- Ensure minimal overhead for existing operations

### Phase 6: Cross-Contract Integration (Tasks 15-16)
**Repository: Both uniswap-v3-core and uniswap-v3-periphery**

**Task 15: Integration Testing [PERIPHERY + CORE]**
- **Test Files**: `test/PositionManagerReferrerIntegration.spec.ts`
- Test integration with existing position management (mint, increase, decrease, collect, burn)
- Test position manager authorization across all position operations
- Test that only original position manager can modify their positions
- Test interaction with protocol fees and SwapRouter referrer fees
- Test core pool contract integration with fee extraction
- Test cross-contract communication
- Test gas costs and performance impact
- Ensure backwards compatibility

**Task 16: Security and Audit Preparation [PERIPHERY + CORE]**
- **Scope**: Both contract sets
- Security review of all new functions in both repositories
- Position manager authorization validation (prevent unauthorized position modifications)
- Reentrancy analysis and protection (especially cross-contract calls)
- Access control validation across contract boundaries
- Fee calculation accuracy verification in core contracts
- Prepare comprehensive audit documentation for both repositories

## Contract Separation Summary

### **Periphery-Only Tasks (1-7, 11-12)**
- **Repository**: uniswap-v3-periphery
- **Primary Contract**: `NonfungiblePositionManager.sol`
- **Focus**: Position management, configuration, view functions, events

### **Core-Only Tasks (8-10, 13-14)**
- **Repository**: uniswap-v3-core  
- **Primary Contract**: `UniswapV3Pool.sol`
- **Focus**: Fee storage, position fee integration, fee collection from pools

### **Cross-Contract Tasks (15-16)**
- **Repository**: Both repositories
- **Focus**: Integration testing, security audit

## Simplified One-To-One Referrer Architecture

### Core Principle: One Position Manager = One Referrer

#### 1. Position Manager Configuration (1:1 Relationship)
```solidity
// In NonfungiblePositionManager.sol
mapping(address => address) public positionManagerReferrers;      // One referrer per position manager
mapping(address => uint24) public positionManagerFeeRates; // One fee rate per position manager

function setPositionManagerReferrer(address referrer) external {
    positionManagerReferrers[msg.sender] = referrer;
    emit PositionManagerReferrerSet(msg.sender, referrer);
}

function setPositionManagerFeeRate(uint24 feeRate) external {
    require(feeRate <= 10000, "Fee rate exceeds 100%");
    positionManagerFeeRates[msg.sender] = feeRate;
    emit PositionManagerFeeRateSet(msg.sender, feeRate);
}

function getPositionManagerConfig(address manager) 
    external view returns (address referrer, uint24 feeRate) 
{
    return (positionManagerReferrers[manager], positionManagerFeeRates[manager]);
}
```

#### 2. Position Creation (Inherits Manager's Configuration)
```solidity
function mint(MintParams calldata params) external payable returns (...) {
    // Set position manager data (immutable after creation)
    address positionManager = msg.sender;
    uint24 referrerFeeRate = positionManagerFeeRates[positionManager];
    
    _positions[tokenId] = Position({
        // ... existing fields
        positionManager: positionManager,        // IMMUTABLE: tracks who created this position
        referrerFeeRate: referrerFeeRate         // IMMUTABLE: fee rate at creation time
    });
    
    emit PositionCreated(tokenId, positionManager, referrerFeeRate);
}
```

#### 3. Pool Fee Collection (Direct to Referrer)
```solidity
// In UniswapV3Pool.sol
function collectPositionManagerFee()
    external
    returns (uint128 amount0, uint128 amount1)
{
    address positionManager = msg.sender;
    
    // Get the ONE referrer for this position manager
    address referrer = INonfungiblePositionManager(nftContract)
        .positionManagerReferrers(positionManager);
    require(referrer != address(0), "No referrer configured");
    
    amount0 = positionManagerFees[positionManager].token0;
    amount1 = positionManagerFees[positionManager].token1;
    
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

#### 4. Usage Pattern Examples
```solidity
// Position Manager A Setup
positionManagerA.setPositionManagerReferrer(referrerX);
positionManagerA.setPositionManagerFeeRate(2500); // 25%

// Position Manager B Setup  
positionManagerB.setPositionManagerReferrer(referrerY);
positionManagerB.setPositionManagerFeeRate(1000); // 10%

// All positions created by A → use referrerX and 25% fee rate
// All positions created by B → use referrerY and 10% fee rate

// Fee collection: Position Manager A calls
pool.collectPositionManagerFee();
// → Fees automatically sent to referrerX

// Fee collection: Position Manager B calls (from position manager B contract)
pool.collectPositionManagerFee();
// → Fees automatically sent to referrerY
```

### Key Simplifications

#### 1. Configuration Simplicity
- **One referrer per position manager** (not per position)
- **One fee rate per position manager** (not per position)
- **Immutable position data**: Set once during mint from manager's config

#### 2. Collection Simplicity  
- Position manager calls pool directly
- Pool automatically sends to THE referrer
- No recipient parameter needed
- No complex routing logic

#### 3. Storage Efficiency
- Two simple mappings in periphery
- Direct public access for pools
- No complex nested structures

#### 4. Security Model
- Position manager controls their referrer
- Referrer receives all fees from that position manager
- No way to redirect fees during collection, cross-contract communication

## Gas Optimization Strategies

1. **Storage Packing**: Pack new fields efficiently in Position struct
2. **Batch Operations**: Support batch fee collection for gas efficiency
3. **Existing Patterns**: Leverage existing fee calculation mechanisms
4. **Minimal Overhead**: Only add computation when referrer fees are configured

## Security Considerations

1. **Fee Rate Limits**: Maximum 100% referrer fee rate (10000 basis points)
2. **Self-Management**: Position managers control their own configuration
3. **Immutable Associations**: Position manager cannot be changed after creation
4. **Position Authorization**: Only original position manager can modify positions they created
5. **Reentrancy Protection**: Use existing patterns from collect() function
6. **Access Control**: Proper validation in configuration and position modification functions

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