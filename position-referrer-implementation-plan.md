# NonfungiblePositionManager Referrer Fee Implementation Plan

## Document Purpose
**This document provides concrete implementation guidance for Position Manager referrer fees.** It contains detailed code examples, step-by-step workflows, implementation components, and development task breakdowns. For technical feasibility analysis and architectural reasoning, see `position-manager-referrer-fee-analysis.md`.

**Target Audience**: Developers implementing the feature, code reviewers, and development teams
**Scope**: Code implementation, workflows, task planning, deployment guidance  
**Companion Document**: `position-manager-referrer-fee-analysis.md` (technical analysis)

## Overview
This document outlines the implementation plan for adding referrer fee functionality to Uniswap V3 NonfungiblePositionManager contracts. The system allows multiple independent NonfungiblePositionManager contract deployments to earn referrer fees from positions they create. Referrer fees are extracted during swap fee calculations (like protocol fees) and provide economic incentives for position management services.

## Terminology

- **Position Manager**: A deployed NonfungiblePositionManager contract address (not an EOA)
- **Original Position Manager**: The specific NonfungiblePositionManager contract that created a position
- **Referrer**: The address configured to receive referrer fees (can be EOA or contract)
- **Position Owner**: The user who owns the NFT position token
- **Multi-Contract Architecture**: Multiple NonfungiblePositionManager contracts can operate independently with different referrer configurations

## Architecture Summary

### Core Components
1. **Multi-Contract Architecture**: Multiple independent NonfungiblePositionManager contracts can operate with different referrer configurations
2. **Simplified Position Storage**: Positions store only original Uniswap data - no referrer-specific fields
3. **Self-Contained Referrer Config**: Each PositionManager stores its own referrer and fee rate
4. **Dynamic Fee Lookup**: Referrer fees retrieved from PositionManager's own storage when needed
5. **Contract-Level Management**: Each PositionManager only manages positions it created
6. **Owner-Controlled Configuration**: Only contract owner can modify referrer settings
7. **Real-Time Updates**: Changes to referrer config immediately affect all positions from that manager
8. **Unchanged LP Flow**: `collect()` function remains completely unchanged for position owners

### Key Features
- **Multi-Contract Support**: Multiple NonfungiblePositionManager contracts operate independently
- **Contract-Based Configuration**: Each NonfungiblePositionManager contract sets its own referrer and fee rate
- **On-Demand Fee Lookup**: Referrer fees retrieved from PositionManager when needed, not stored with position data
- **Dynamic Configuration**: Changes to PositionManager referrer settings affect all existing positions from that manager
- **Position Fee Integration**: Referrer fees extracted during existing position fee calculations
- **Direct Collection**: NonfungiblePositionManager contracts collect from pools like `collectProtocol()`
- **Contract Authorization**: Only the original NonfungiblePositionManager contract can modify positions it created
- **Cross-Contract Security**: Prevents unauthorized access between different contract deployments
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
4. **NonfungiblePositionManager contract authorization** - Only original position manager can modify their positions

## Complete User Flow Documentation

**Key Definitions:**
- **Position Manager** = NonfungiblePositionManager contract address (not EOA)
- **Original Position Manager** = The specific NonfungiblePositionManager contract that created the position
- **Authorization** = Pool verifies operations come through the original NonfungiblePositionManager contract

The position manager referrer fee system involves 9 key user flows:

### **Flow 1: NonfungiblePositionManager Configuration**
```
1. Admin/Owner calls setPositionManagerReferrer(referrerAddress) → NonfungiblePositionManager contract
2. Admin/Owner calls setPositionManagerFeeRate(feeRate) → NonfungiblePositionManager contract
3. Configuration stored in NonfungiblePositionManager contract storage
4. This configuration applies to ALL positions created through this specific contract
5. Emit PositionManagerReferrerSet and PositionManagerFeeRateSet events
```

### **Flow 2: Position Creation through NonfungiblePositionManager**
```
1. User calls mint(params) → NonfungiblePositionManager contract (periphery)
2. NonfungiblePositionManager creates position in its own storage (standard Position struct)
3. NonfungiblePositionManager calls pool.mint() → UniswapV3Pool (core)
4. Pool creates position with: positions[positionKey].positionManager = msg.sender
   - Pool stores which PositionManager created this position
5. Pool retrieves current referrer config: (referrer, feeRate) = msg.sender.getReferrerConfig()
   - Dynamic lookup gets real-time referrer configuration
6. Pool calls _updatePosition() with current referrer address and fee rate  
7. If referrer != address(0): _updatePosition() extracts referrer fees for this PositionManager
8. Position created in both PositionManager storage and Pool storage
9. Emit PositionCreated event
```

### **Flow 3: Position Updates through Original NonfungiblePositionManager**
```
1. User calls increaseLiquidity(params) or decreaseLiquidity(params) → NonfungiblePositionManager
2. NonfungiblePositionManager loads position data (standard Uniswap position struct - no referrer fields)
3. NonfungiblePositionManager calls pool operation → UniswapV3Pool  
4. Pool checks authorization: require(positions[positionKey].positionManager == msg.sender)
   - Only the original NonfungiblePositionManager contract can modify positions it created
5. Pool retrieves current referrer config: (referrer, feeRate) = msg.sender.getReferrerConfig()
   - Dynamic lookup gets real-time referrer configuration from calling PositionManager
6. Pool calls _updatePosition() with current referrer address and fee rate
7. _updatePosition() extracts referrer fees for this PositionManager if referrer != address(0)
8. Referrer fees accumulated in pool storage per PositionManager
9. Position updated with latest fee calculations
```

### **Flow 4: Referrer Fee Calculation & Storage (During Any Swap)**
```
1. User performs swap → UniswapV3Pool.swap()
2. Swap triggers fee calculations and position updates
3. For each affected position: _updatePosition(..., nftManagerAddress, referrerFeeRate) called
4. Pool uses the NonfungiblePositionManager address stored in the position
5. IF nftManagerAddress != address(0) AND referrerFeeRate > 0:
   a. Calculate referrer fees: (positionLPFees * referrerFeeRate) / 10000
   b. Accumulate in positionManagerFees[nftManagerAddress]
   c. Reduce position owner fees by referrer amount
6. Fees accumulated per NonfungiblePositionManager contract address
```

### **Flow 5: NonfungiblePositionManager Fee Withdrawal**
```
1. Admin/Owner calls NonfungiblePositionManager.collectFeesFromPool(poolAddress) → NonfungiblePositionManager (periphery)
2. NonfungiblePositionManager verifies caller is contract owner (onlyOwner modifier)
3. NonfungiblePositionManager calls pool.collectPositionManagerFee() → UniswapV3Pool (core)
   - msg.sender = NonfungiblePositionManager contract address
4. Pool identifies caller as NonfungiblePositionManager contract (msg.sender)
5. Pool calls INonfungiblePositionManager(msg.sender).positionManagerReferrer()
   - Pool queries the calling NonfungiblePositionManager for its referrer
6. Pool gets referrer address from the NonfungiblePositionManager contract
7. require(referrer != address(0), "No referrer configured")
8. Pool reads accumulated fees: positionManagerFees[msg.sender]
9. Pool transfers accumulated fees directly to referrer:
   a. IF token0 amount > 0: transfer token0 to referrer, clear storage
   b. IF token1 amount > 0: transfer token1 to referrer, clear storage
10. Pool clears accumulated fees for this NonfungiblePositionManager contract
11. Pool returns (amount0, amount1) to NonfungiblePositionManager
12. NonfungiblePositionManager returns (amount0, amount1) to admin
13. Emit CollectPositionManagerFee(nftManagerAddress, referrer, amount0, amount1)
```

**Key Points for Fee Withdrawal:**
- Admin/Owner calls NonfungiblePositionManager, which then calls pool
- Admin cannot call pool directly (requires msg.sender == NonfungiblePositionManager contract)
- Fees go directly to the referrer configured in that NonfungiblePositionManager
- Admin triggers collection but never receives fees directly
- Each NonfungiblePositionManager contract has its own referrer and fee accumulation
- Multiple NonfungiblePositionManager contracts can operate independently
- Admin must call collectFeesFromPool() on each pool separately for multi-pool collection

### **Flow 6: Position Deletion through Original NonfungiblePositionManager**
```
1. User calls burn(tokenId) → NonfungiblePositionManager contract
2. NonfungiblePositionManager calls pool.burn() → UniswapV3Pool
3. Pool checks: require(positions[positionKey].positionManager == msg.sender)
   - Only the original NonfungiblePositionManager contract can burn the position
4. Core pool calls _updatePosition() for final fee extraction
5. Final referrer fees calculated and stored for the NonfungiblePositionManager contract
6. Position data cleared from pool
7. NonfungiblePositionManager can later withdraw accumulated fees
```

### **Flow 7: Position Owner Fee Collection (Unchanged)**
```
1. Position Owner calls collect(params) → NonfungiblePositionManager contract
2. NonfungiblePositionManager calls pool.collect() → UniswapV3Pool
3. Pool returns LP fees (already reduced by referrer fees during swaps)
4. Position owner receives remaining fees after referrer extraction
5. NO changes to existing collect() flow - completely backwards compatible
```

### **Flow 8: Contract Authorization Flow**
```
1. Any position modification function called on pool
2. Pool checks: require(positions[positionKey].positionManager == msg.sender)
3. Only the original NonfungiblePositionManager contract that created position can modify it
4. Other NonfungiblePositionManager contracts blocked from modifying positions they didn't create
5. This prevents cross-contract unauthorized access
```

### **Flow 9: Cross-Contract Communication Flow**
```
1. Pool needs referrer address for fee collection
2. Pool calls the NonfungiblePositionManager contract that's calling it:
   INonfungiblePositionManager(msg.sender).positionManagerReferrers()
3. NonfungiblePositionManager returns its configured referrer address
4. Pool transfers fees directly to that referrer
5. Each NonfungiblePositionManager contract manages its own referrer configuration
```

**Multi-Contract Architecture:**
- Multiple NonfungiblePositionManager contracts can exist
- Each has its own referrer configuration and fee accumulation
- Pool tracks which NonfungiblePositionManager created each position
- Only original NonfungiblePositionManager can modify/delete positions it created

## Implementation Components

### 1. Two-Level Storage Architecture

#### A. PositionManager Level (Periphery) - Position Struct Unchanged

```solidity
// PositionManager Position struct remains unchanged from original Uniswap V3
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
    // NO referrer-specific fields added - referrer config retrieved dynamically
}
```

#### B. Pool Level (Core) - Enhanced Position Storage Required

```solidity
// Pool position storage (in uniswap-v3-core) needs enhancement
struct Position {
    uint128 liquidity;
    uint256 feeGrowthInside0LastX128;
    uint256 feeGrowthInside1LastX128;
    uint128 tokensOwed0;
    uint128 tokensOwed1;
    address positionManager;  // NEW: Track which PositionManager created this position
}
```

**Key Architecture Points:**
- **PositionManager**: Stores referrer config, Position struct unchanged
- **Pool**: Stores `positionManager` address per position for authorization and dynamic lookup
- **Dynamic Referrer Lookup**: Pool calls `positionManager.getReferrerConfig()` when needed

### 2. Position Manager Self-Contained Configuration

```solidity
// Self-contained referrer configuration per PositionManager contract
address public referrer;           // This contract's referrer address  
uint24 public referrerFeeRate;     // This contract's fee rate (0-500 basis points = 0%-5%)

/// @notice Set referrer address for this PositionManager contract
/// @dev Only callable by contract owner. Affects ALL positions from this contract.
/// @param _referrer Address to receive referrer fees
function setReferrer(address _referrer) external onlyOwner {
    address oldReferrer = referrer;
    referrer = _referrer;
    emit ReferrerChanged(oldReferrer, _referrer);
}

/// @notice Set referrer fee rate for this PositionManager contract  
/// @dev Only callable by contract owner. Applies to ALL positions from this contract.
/// @param _feeRate Fee rate in basis points (0-500 = 0%-5%)
function setReferrerFeeRate(uint24 _feeRate) external onlyOwner {
    require(_feeRate <= 500, 'Fee rate too high'); // Max 5%
    uint24 oldFeeRate = referrerFeeRate;
    referrerFeeRate = _feeRate;
    emit ReferrerFeeRateChanged(oldFeeRate, _feeRate);
}

/// @notice Collect accumulated referrer fees from a specific pool
/// @dev Only callable by contract owner/admin. Fees sent directly to configured referrer.
/// @param poolAddress The pool to collect fees from
/// @return amount0 Amount of token0 collected and sent to referrer
/// @return amount1 Amount of token1 collected and sent to referrer
function collectFeesFromPool(address poolAddress) 
    external 
    onlyOwner 
    returns (uint128 amount0, uint128 amount1);

/// @notice Collect accumulated referrer fees from multiple pools
/// @dev Only callable by contract owner/admin. Fees sent directly to configured referrer.
/// @param poolAddresses Array of pools to collect fees from
/// @return amounts0 Array of token0 amounts collected per pool
/// @return amounts1 Array of token1 amounts collected per pool
function collectFeesFromPools(address[] calldata poolAddresses)
    external
    onlyOwner
    returns (uint128[] memory amounts0, uint128[] memory amounts1);

/// @notice Get referrer configuration for any NonfungiblePositionManager contract
/// @dev Can be called by anyone, typically used by pools to get referrer info
/// @param positionManager NonfungiblePositionManager contract address to query
/// @return referrer Referrer address configured for that contract
/// @return feeRate Fee rate in basis points configured for that contract
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

### Phase 1: Periphery Infrastructure (Tasks 1-4)
**Repository: uniswap-v3-periphery**

**Task 1: Enhance Position Struct [PERIPHERY]**
- **Contract**: `NonfungiblePositionManager.sol`
- Add `positionManager` field (address, immutable after creation)
- Add `referrerFeeRate` field (uint24, 0-10000 basis points for 0-100%)
- Optimize storage packing to minimize gas costs
- Update Position struct documentation

**Task 2: Position Manager Configuration, Authorization, and Fee Collection [PERIPHERY]**
- **Contract**: `NonfungiblePositionManager.sol`
- Add `onlyPositionManager(uint256 tokenId)` modifier for position access control
- Implement `setPositionManagerReferrer(address referrer)` function with `onlyOwner` modifier
- Implement `setPositionManagerFeeRate(uint24 feeRate)` function with `onlyOwner` modifier and validation
- Add validation: `require(feeRate <= 10000, "Fee rate exceeds 100%")`
- Implement `collectFeesFromPool(address poolAddress)` function with `onlyOwner` modifier
- Implement `collectFeesFromPools(address[] poolAddresses)` function with `onlyOwner` modifier
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

### Phase 2: Periphery View Functions and Events (Tasks 5-6)
**Repository: uniswap-v3-periphery**

**Task 5: Pool Integration Interface [PERIPHERY]**
- **Contract**: `NonfungiblePositionManager.sol`
- Provide public view functions for pool contracts to access referrer configuration
- Ensure `positionManagerReferrers` and `positionManagerFeeRates` are publicly accessible
- Add helper functions for position manager queries if needed

**Task 6: View and Collection Functions [PERIPHERY]**
- **Contract**: `NonfungiblePositionManager.sol`
- Implement `getPositionManagerConfig(address manager)` returns (address referrer, uint24 feeRate)
- Implement admin fee collection functions:
  - `collectFeesFromPool(address poolAddress)` - single pool collection
  - `collectFeesFromPools(address[] poolAddresses)` - multi-pool collection
- Add helper functions for position manager queries
- Ensure efficient gas usage for read operations
- Add proper error handling for failed pool calls

**Task 7: Event System [PERIPHERY]**
- **Contract**: `NonfungiblePositionManager.sol`
- Implement `PositionCreated(tokenId, positionManager, referrerFeeRate)` event
- Implement `PositionManagerReferrerSet(positionManager, referrer)` event  
- Implement `PositionManagerFeeRateSet(positionManager, feeRate)` event
- Implement `FeesCollectedFromPool(poolAddress, referrer, amount0, amount1)` event
- Implement `FeesCollectedFromPool(poolAddresses, referrer, totalAmount0, totalAmount1)` event

### Phase 3: Core Pool Integration (Tasks 7-9)
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

### Phase 4: Periphery Testing (Tasks 10-11)
**Repository: uniswap-v3-periphery**

**Task 11: Periphery Unit Testing [PERIPHERY]**
- **Test Files**: `test/PositionManagerReferrer.spec.ts`
- Test NonfungiblePositionManager contract configuration functions
- Test position creation with referrer tracking
- Test NonfungiblePositionManager contract authorization (only original NonfungiblePositionManager contract can modify positions)
- Test unauthorized access prevention (other NonfungiblePositionManager contracts cannot modify positions)
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

### Phase 5: Core Testing (Tasks 12-13)
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

### Phase 6: Cross-Contract Integration (Tasks 14-15)
**Repository: Both uniswap-v3-core and uniswap-v3-periphery**

**Task 15: Integration Testing [PERIPHERY + CORE]**
- **Test Files**: `test/PositionManagerReferrerIntegration.spec.ts`
- Test integration with existing position management (mint, increase, decrease, collect, burn)
- Test NonfungiblePositionManager contract authorization across all position operations
- Test that only original position manager can modify their positions
- Test interaction with protocol fees and SwapRouter referrer fees
- Test core pool contract integration with fee extraction
- Test cross-contract communication
- Test gas costs and performance impact
- Ensure backwards compatibility

**Task 16: Security and Audit Preparation [PERIPHERY + CORE]**
- **Scope**: Both contract sets
- Security review of all new functions in both repositories
- NonfungiblePositionManager contract authorization validation (prevent unauthorized position modifications)
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
    // Set NonfungiblePositionManager contract data (immutable after creation)
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
- **One referrer per NonfungiblePositionManager contract** (not per position)
- **One fee rate per NonfungiblePositionManager contract** (not per position)  
- **Immutable position data**: Set once during mint from contract's config
- **Contract-level management**: Each contract deployment manages its own configuration

#### 2. Collection Simplicity  
- NonfungiblePositionManager contract calls pool directly
- Pool automatically sends to that contract's configured referrer
- No recipient parameter needed
- No complex routing logic
- Each contract collects its own accumulated fees

#### 3. Storage Efficiency
- Simple instance variables per contract deployment
- Direct public access for pools
- No complex nested structures
- Separate fee accumulation per contract in pools

#### 4. Security Model
- Each NonfungiblePositionManager contract controls its own referrer
- Each contract's referrer receives all fees from positions created by that contract
- No way to redirect fees during collection
- Cross-contract authorization prevents unauthorized modifications
- Contract isolation prevents interference between different deployments

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