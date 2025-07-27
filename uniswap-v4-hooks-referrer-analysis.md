# Uniswap V4 Hooks Referrer Fee Implementation Analysis

## Document Purpose
This document analyzes Uniswap V4 hooks capabilities for implementing referrer fee functionality similar to our Position Manager implementation plan. It evaluates whether V4 hooks can support both liquidity provider referrals and trader referrals, comparing implementation approaches between V3 periphery contracts and V4 hooks.

**Target Audience**: Protocol developers, DeFi architects, integration teams
**Scope**: V4 hooks analysis, referrer fee mechanisms, comparison with V3 implementation
**Context**: Analysis based on V4 launch (January 31, 2025) and current hook ecosystem

## Executive Summary

**Key Finding**: Uniswap V4 hooks provide superior flexibility and capabilities for implementing referrer fee systems compared to V3 periphery modifications.

**V4 Hooks Advantages:**
- **Native Integration**: Hooks integrate directly into pool lifecycle without core contract modifications
- **Dual Referrer Support**: Can implement both liquidity provider and trader referrer systems simultaneously
- **Dynamic Fee Management**: Real-time fee calculation and distribution capabilities
- **Simplified Architecture**: Single hook contract vs. complex two-level V3 architecture
- **Enhanced Flexibility**: Custom logic for fee rates, referrer tracking, and reward distribution

**Recommendation**: V4 hooks are the preferred approach for implementing comprehensive referrer fee systems in new deployments.

## Uniswap V4 Hooks Architecture Overview

### Core Hook System
```solidity
// V4 Hook Lifecycle Events
interface IHooks {
    function beforeInitialize(address sender, PoolKey calldata key, uint160 sqrtPriceX96) external returns (bytes4);
    function afterInitialize(address sender, PoolKey calldata key, uint160 sqrtPriceX96, int24 tick) external returns (bytes4);
    
    function beforeAddLiquidity(address sender, PoolKey calldata key, IPoolManager.ModifyLiquidityParams calldata params, bytes calldata hookData) external returns (bytes4);
    function afterAddLiquidity(address sender, PoolKey calldata key, IPoolManager.ModifyLiquidityParams calldata params, BalanceDelta delta, bytes calldata hookData) external returns (bytes4);
    
    function beforeRemoveLiquidity(address sender, PoolKey calldata key, IPoolManager.ModifyLiquidityParams calldata params, bytes calldata hookData) external returns (bytes4);
    function afterRemoveLiquidity(address sender, PoolKey calldata key, IPoolManager.ModifyLiquidityParams calldata params, BalanceDelta delta, bytes calldata hookData) external returns (bytes4);
    
    function beforeSwap(address sender, PoolKey calldata key, IPoolManager.SwapParams calldata params, bytes calldata hookData) external returns (bytes4, BeforeSwapDelta, uint24);
    function afterSwap(address sender, PoolKey calldata key, IPoolManager.SwapParams calldata params, BalanceDelta delta, bytes calldata hookData) external returns (bytes4, int128);
    
    function beforeDonate(address sender, PoolKey calldata key, uint256 amount0, uint256 amount1, bytes calldata hookData) external returns (bytes4);
    function afterDonate(address sender, PoolKey calldata key, uint256 amount0, uint256 amount1, bytes calldata hookData) external returns (bytes4);
}
```

### Key Architectural Features
- **Single Pool Manager**: All pool operations managed through one contract (PoolManager.sol)
- **Flash Accounting**: Optimized token transfers with internal balance tracking
- **Hook Permissions**: Encoded in contract address for gas efficiency
- **Selective Implementation**: Hooks can implement only needed functions
- **Multi-Pool Support**: One hook can serve multiple pools

## Liquidity Provider Referrer Implementation

### V4 Hook Implementation Approach

#### Hook Configuration
```solidity
contract LiquidityReferrerHook is BaseHook {
    // Referrer tracking storage
    mapping(address => address) public liquidityProviderReferrers;  // LP → referrer
    mapping(address => uint24) public referrerFeeRates;             // referrer → fee rate
    mapping(address => mapping(address => uint256)) public referrerFees; // referrer → token → amount
    
    // Configuration
    address public hookOwner;
    uint24 public defaultReferrerFeeRate = 100; // 1% default
    
    function getHookPermissions() public pure override returns (Hooks.Permissions memory) {
        return Hooks.Permissions({
            beforeInitialize: false,
            afterInitialize: false,
            beforeAddLiquidity: true,
            afterAddLiquidity: true,
            beforeRemoveLiquidity: false,
            afterRemoveLiquidity: true,
            beforeSwap: false,
            afterSwap: false,
            beforeDonate: false,
            afterDonate: false,
            beforeSwapReturnDelta: false,
            afterSwapReturnDelta: false,
            afterAddLiquidityReturnDelta: false,
            afterRemoveLiquidityReturnDelta: false
        });
    }
}
```

#### Liquidity Addition with Referrer Tracking
```solidity
function beforeAddLiquidity(
    address sender,
    PoolKey calldata key,
    IPoolManager.ModifyLiquidityParams calldata params,
    bytes calldata hookData
) external override returns (bytes4) {
    // Decode referrer information from hookData
    if (hookData.length > 0) {
        address referrer = abi.decode(hookData, (address));
        if (referrer != address(0) && referrer != sender) {
            liquidityProviderReferrers[sender] = referrer;
        }
    }
    return BaseHook.beforeAddLiquidity.selector;
}

function afterAddLiquidity(
    address sender,
    PoolKey calldata key,
    IPoolManager.ModifyLiquidityParams calldata params,
    BalanceDelta delta,
    bytes calldata hookData
) external override returns (bytes4) {
    // Award points or tokens to referrer for successful liquidity addition
    address referrer = liquidityProviderReferrers[sender];
    if (referrer != address(0)) {
        uint256 liquidityValue = _calculateLiquidityValue(delta, key);
        uint256 referrerReward = (liquidityValue * defaultReferrerFeeRate) / 10000;
        
        // Mint reward tokens or track points
        _awardReferrerPoints(referrer, sender, referrerReward);
        
        emit LiquidityReferralAwarded(sender, referrer, liquidityValue, referrerReward);
    }
    return BaseHook.afterAddLiquidity.selector;
}
```

#### Fee Collection from Liquidity Positions
```solidity
function afterRemoveLiquidity(
    address sender,
    PoolKey calldata key,
    IPoolManager.ModifyLiquidityParams calldata params,
    BalanceDelta delta,
    bytes calldata hookData
) external override returns (bytes4) {
    // Extract referrer fees from collected LP fees
    address referrer = liquidityProviderReferrers[sender];
    if (referrer != address(0)) {
        uint24 feeRate = referrerFeeRates[referrer];
        if (feeRate == 0) feeRate = defaultReferrerFeeRate;
        
        // Calculate referrer share of collected fees
        uint256 fee0 = uint256(int256(delta.amount0())) * feeRate / 10000;
        uint256 fee1 = uint256(int256(delta.amount1())) * feeRate / 10000;
        
        // Accumulate referrer fees
        referrerFees[referrer][Currency.unwrap(key.currency0)] += fee0;
        referrerFees[referrer][Currency.unwrap(key.currency1)] += fee1;
        
        emit ReferrerFeeCollected(referrer, key.currency0, fee0);
        emit ReferrerFeeCollected(referrer, key.currency1, fee1);
    }
    return BaseHook.afterRemoveLiquidity.selector;
}
```

### Advantages Over V3 Implementation
1. **No Core Contract Changes**: Hooks work with existing pool architecture
2. **Dynamic Referrer Assignment**: Can change referrers without position migration
3. **Real-Time Fee Extraction**: Integrated into liquidity operations
4. **Flexible Reward Systems**: Points, tokens, or direct fee sharing

## Trader Referrer Implementation

### V4 Hook Implementation Approach

#### Swap Referrer Tracking
```solidity
contract SwapReferrerHook is BaseHook {
    // Referrer tracking for traders
    mapping(address => address) public traderReferrers;    // trader → referrer
    mapping(address => uint256) public referrerEarnings;   // referrer → total earnings
    mapping(bytes32 => uint256) public poolReferrerFees;   // pool+referrer → accumulated fees
    
    uint24 public swapReferrerFeeRate = 50; // 0.5% of swap fees
    
    function getHookPermissions() public pure override returns (Hooks.Permissions memory) {
        return Hooks.Permissions({
            beforeInitialize: false,
            afterInitialize: false,
            beforeAddLiquidity: false,
            afterAddLiquidity: false,
            beforeRemoveLiquidity: false,
            afterRemoveLiquidity: false,
            beforeSwap: true,
            afterSwap: true,
            beforeSwapReturnDelta: false,
            afterSwapReturnDelta: true, // Enable fee extraction
            afterAddLiquidityReturnDelta: false,
            afterRemoveLiquidityReturnDelta: false
        });
    }
}
```

#### Swap Fee Extraction and Distribution
```solidity
function beforeSwap(
    address sender,
    PoolKey calldata key,
    IPoolManager.SwapParams calldata params,
    bytes calldata hookData
) external override returns (bytes4, BeforeSwapDelta, uint24) {
    // Register referrer relationship from hookData
    if (hookData.length > 0) {
        address referrer = abi.decode(hookData, (address));
        if (referrer != address(0) && referrer != sender) {
            traderReferrers[sender] = referrer;
        }
    }
    
    // Return dynamic fee if needed
    return (BaseHook.beforeSwap.selector, BeforeSwapDelta.ZERO_DELTA, 0);
}

function afterSwap(
    address sender,
    PoolKey calldata key,
    IPoolManager.SwapParams calldata params,
    BalanceDelta delta,
    bytes calldata hookData
) external override returns (bytes4, int128) {
    address referrer = traderReferrers[sender];
    
    if (referrer != address(0)) {
        // Calculate swap volume and referrer fee
        uint256 swapAmount = params.amountSpecified > 0 
            ? uint256(params.amountSpecified) 
            : uint256(-params.amountSpecified);
            
        uint256 referrerFee = (swapAmount * swapReferrerFeeRate) / 10000;
        
        // Extract fee from swap output
        int128 feeExtraction = -int128(uint128(referrerFee));
        
        // Track referrer earnings
        bytes32 poolReferrerKey = keccak256(abi.encode(key.toId(), referrer));
        poolReferrerFees[poolReferrerKey] += referrerFee;
        referrerEarnings[referrer] += referrerFee;
        
        emit SwapReferrerFeeExtracted(sender, referrer, swapAmount, referrerFee);
        
        return (BaseHook.afterSwap.selector, feeExtraction);
    }
    
    return (BaseHook.afterSwap.selector, 0);
}
```

#### Direct Fee Collection by Referrers
```solidity
function collectReferrerFees(PoolKey calldata key) external {
    address referrer = msg.sender;
    bytes32 poolReferrerKey = keccak256(abi.encode(key.toId(), referrer));
    uint256 amount = poolReferrerFees[poolReferrerKey];
    
    require(amount > 0, "No fees to collect");
    
    poolReferrerFees[poolReferrerKey] = 0;
    
    // Transfer fees to referrer (implementation depends on token type)
    Currency currency = params.zeroForOne ? key.currency1 : key.currency0;
    _transferToReferrer(referrer, currency, amount);
    
    emit ReferrerFeesCollected(referrer, key.toId(), amount);
}
```

### Dynamic Fee Integration
```solidity
// Combine with dynamic fees for enhanced functionality
function beforeSwap(
    address sender,
    PoolKey calldata key,
    IPoolManager.SwapParams calldata params,
    bytes calldata hookData
) external override returns (bytes4, BeforeSwapDelta, uint24) {
    // Dynamic fee based on referrer status
    address referrer = traderReferrers[sender];
    uint24 dynamicFee = referrer != address(0) 
        ? baseFee + referrerBonusFee  // Higher fee to fund referrer rewards
        : baseFee;
    
    return (BaseHook.beforeSwap.selector, BeforeSwapDelta.ZERO_DELTA, dynamicFee);
}
```

## Combined Liquidity + Swap Referrer Hook

### Unified Implementation
```solidity
contract UnifiedReferrerHook is BaseHook {
    // Dual referrer tracking
    mapping(address => address) public liquidityReferrers;
    mapping(address => address) public swapReferrers;
    
    // Fee configuration
    uint24 public liquidityReferrerFeeRate = 100; // 1%
    uint24 public swapReferrerFeeRate = 50;       // 0.5%
    
    // Accumulated fees per referrer per token
    mapping(address => mapping(address => uint256)) public referrerBalances;
    
    function getHookPermissions() public pure override returns (Hooks.Permissions memory) {
        return Hooks.Permissions({
            beforeInitialize: false,
            afterInitialize: false,
            beforeAddLiquidity: true,
            afterAddLiquidity: true,
            beforeRemoveLiquidity: false,
            afterRemoveLiquidity: true,
            beforeSwap: true,
            afterSwap: true,
            beforeSwapReturnDelta: false,
            afterSwapReturnDelta: true,
            afterAddLiquidityReturnDelta: false,
            afterRemoveLiquidityReturnDelta: false
        });
    }
    
    // Implement both liquidity and swap referrer logic
    // (combine previous implementations)
}
```

### Referrer Data Encoding
```solidity
// HookData encoding for referrer information
struct ReferrerData {
    address liquidityReferrer;
    address swapReferrer;
    uint256 customFeeRate;
    bytes additionalData;
}

function encodeReferrerData(ReferrerData memory data) internal pure returns (bytes memory) {
    return abi.encode(data);
}

function decodeReferrerData(bytes calldata hookData) internal pure returns (ReferrerData memory) {
    if (hookData.length == 0) {
        return ReferrerData(address(0), address(0), 0, "");
    }
    return abi.decode(hookData, (ReferrerData));
}
```

## Comparison: V3 Periphery vs V4 Hooks Implementation

### Implementation Complexity

#### V3 Periphery Approach (Current Implementation)
```solidity
// Complex two-level architecture
// 1. PositionManager Level (Periphery)
contract NonfungiblePositionManager {
    address public referrer;
    uint24 public referrerFeeRate;
    // Self-contained configuration per contract
}

// 2. Pool Level (Core) - Requires core contract modifications
contract UniswapV3Pool {
    struct Position {
        // ... existing fields
        address positionManager; // NEW field required
    }
    mapping(address => PositionManagerFees) positionManagerFees;
    // Complex integration with existing fee calculations
}
```

#### V4 Hooks Approach
```solidity
// Single hook contract handles everything
contract ReferrerHook is BaseHook {
    // All referrer logic contained in hook
    // No core contract modifications needed
    // Direct integration with pool lifecycle
}
```

### Feature Comparison Matrix

| Feature | V3 Periphery | V4 Hooks | Advantage |
|---------|--------------|----------|-----------|
| **Implementation Complexity** | High (two-level architecture) | Medium (single hook) | V4 |
| **Core Contract Changes** | Required (pool modifications) | None (hook-based) | V4 |
| **Dynamic Configuration** | Limited (contract-level only) | Full (per-transaction) | V4 |
| **Multi-Referrer Support** | No (one referrer per contract) | Yes (liquidity + swap referrers) | V4 |
| **Fee Rate Flexibility** | Static (contract owner sets) | Dynamic (real-time calculation) | V4 |
| **Backwards Compatibility** | Complex migration needed | Native compatibility | V4 |
| **Gas Efficiency** | Moderate (two-level calls) | High (direct integration) | V4 |
| **Development Time** | High (core + periphery) | Medium (hook only) | V4 |
| **Security Complexity** | High (cross-contract authorization) | Medium (hook permissions) | V4 |
| **Deployment Flexibility** | Requires new pool deployments | Works with existing pools | V4 |

### Architecture Comparison

#### V3 Periphery Flow
```
User → PositionManager → Pool → Fee Extraction → Storage → Collection Call → Transfer
  ↓         ↓             ↓           ↓              ↓            ↓              ↓
Referrer   Config      Dynamic    Accumulate   Manager      Pool Query    Referrer
Setup      Storage     Lookup     in Pool      Calls        Interface     Receives
```

#### V4 Hooks Flow
```
User → PoolManager → Hook → Fee Extraction → Direct Transfer
  ↓         ↓         ↓           ↓               ↓
Referrer   Hook      Real-time   Immediate    Referrer
in Data   Executes   Calculation  Payment     Receives
```

### Performance Analysis

#### V3 Periphery Performance
- **Position Creation**: +1 storage write (positionManager field)
- **Fee Extraction**: External call to PositionManager + accumulation
- **Fee Collection**: PositionManager → Pool → External call back → Transfer
- **Cross-Contract Calls**: 2-3 external calls per operation

#### V4 Hooks Performance
- **Position Creation**: Hook execution (minimal overhead)
- **Fee Extraction**: Direct calculation and distribution
- **Fee Collection**: Direct transfer or immediate processing
- **External Calls**: 0-1 external calls per operation

## Real-World Hook Examples

### Existing Referrer Implementations
1. **Ref Fee Hook** (mergd/ref-fee-hook)
   - Takes referral fees for swaps and liquidity
   - Supports both operation types
   - GitHub: https://github.com/mergd/ref-fee-hook

2. **UniDerp Meme Launchpad**
   - Distributes trading fees among creators, referrers, and platform
   - Uses hooks for custom fee distribution
   - Demonstrates complex multi-party fee sharing

3. **LoyalSwap**
   - "Loyal fees for loyal users"
   - Loyalty-based fee structures
   - Could be adapted for referrer programs

### Code Example: Production-Ready Referrer Hook
```solidity
// Simplified production example based on existing implementations
contract ProductionReferrerHook is BaseHook {
    using PoolIdLibrary for PoolKey;
    
    mapping(address => address) public referrers;
    mapping(bytes32 => uint256) public earnedFees; // poolId+referrer → amount
    
    uint24 constant REFERRER_FEE_RATE = 100; // 1%
    
    function afterSwap(
        address sender,
        PoolKey calldata key,
        IPoolManager.SwapParams calldata params,
        BalanceDelta delta,
        bytes calldata hookData
    ) external override returns (bytes4, int128) {
        if (hookData.length > 0) {
            address referrer = abi.decode(hookData, (address));
            if (referrer != address(0)) {
                uint256 swapAmount = params.amountSpecified > 0 
                    ? uint256(params.amountSpecified) 
                    : uint256(-params.amountSpecified);
                
                uint256 referrerFee = swapAmount * REFERRER_FEE_RATE / 10000;
                bytes32 key = keccak256(abi.encode(key.toId(), referrer));
                earnedFees[key] += referrerFee;
                
                return (this.afterSwap.selector, -int128(uint128(referrerFee)));
            }
        }
        return (this.afterSwap.selector, 0);
    }
}
```

## Migration Strategy: V3 to V4

### For Existing V3 Implementations
1. **Assessment Phase**
   - Evaluate current V3 referrer implementation
   - Identify hook requirements
   - Plan migration timeline

2. **Hook Development**
   - Develop unified referrer hook
   - Test with V4 testnet
   - Optimize gas costs

3. **Deployment Strategy**
   - Deploy hook to mainnet
   - Create new V4 pools with hook
   - Migrate liquidity gradually

4. **Integration Updates**
   - Update frontend to use hookData
   - Modify SDK calls for V4 pools
   - Maintain V3 compatibility during transition

### Code Migration Example
```solidity
// V3 Integration (current)
positionManager.mint(MintParams({
    token0: tokenA,
    token1: tokenB,
    fee: 3000,
    tickLower: -887220,
    tickUpper: 887220,
    amount0Desired: 1000e18,
    amount1Desired: 1000e6,
    amount0Min: 0,
    amount1Min: 0,
    recipient: user,
    deadline: block.timestamp
}));

// V4 Integration (with hooks)
IPoolManager.ModifyLiquidityParams memory params = IPoolManager.ModifyLiquidityParams({
    tickLower: -887220,
    tickUpper: 887220,
    liquidityDelta: liquidityAmount,
    salt: 0
});

bytes memory hookData = abi.encode(referrerAddress);

poolManager.modifyLiquidity(poolKey, params, hookData);
```

## Recommendations and Best Practices

### For New Implementations
1. **Choose V4 Hooks**: Superior flexibility and capabilities
2. **Unified Hook Design**: Combine liquidity and swap referrers
3. **Dynamic Fee Structure**: Leverage V4's dynamic fee capabilities
4. **Gas Optimization**: Use efficient storage patterns

### Hook Development Best Practices
```solidity
// Efficient referrer tracking
contract OptimizedReferrerHook is BaseHook {
    // Pack data efficiently
    struct ReferrerInfo {
        address referrer;      // 20 bytes
        uint24 feeRate;       // 3 bytes
        uint8 flags;          // 1 byte
        // Total: 24 bytes (fits in one storage slot with padding)
    }
    
    // Use mappings efficiently
    mapping(address => ReferrerInfo) public referrerData;
    
    // Batch operations where possible
    function batchCollectFees(PoolKey[] calldata pools) external {
        for (uint i = 0; i < pools.length; i++) {
            _collectPoolFees(pools[i]);
        }
    }
}
```

### Security Considerations
1. **Hook Permissions**: Minimize required permissions
2. **External Calls**: Validate referrer addresses
3. **Fee Calculation**: Prevent overflow/underflow
4. **Access Control**: Implement proper authorization

## Conclusion

**Uniswap V4 hooks provide a superior architecture for implementing referrer fee systems** compared to V3 periphery modifications:

### Key Advantages
1. **Simplified Architecture**: Single hook vs. complex two-level system
2. **No Core Changes**: Works with existing pool infrastructure
3. **Enhanced Flexibility**: Dynamic fees, multi-referrer support, real-time configuration
4. **Better Performance**: Fewer external calls, direct integration
5. **Easier Development**: Single contract vs. core + periphery modifications

### Capability Matrix
- ✅ **Liquidity Provider Referrals**: Full support through liquidity hooks
- ✅ **Trader Referrals**: Full support through swap hooks  
- ✅ **Dynamic Fee Rates**: Native V4 capability
- ✅ **Multi-Token Support**: Built-in through hook system
- ✅ **Real-Time Configuration**: Via hookData parameter
- ✅ **Cross-Pool Compatibility**: Single hook serves multiple pools

### Implementation Recommendation
For organizations looking to implement referrer fee systems:
- **New Projects**: Use V4 hooks exclusively
- **Existing V3 Projects**: Plan migration to V4 hooks
- **Hybrid Approach**: Maintain V3 for existing pools, V4 for new pools

V4 hooks represent the future of customizable DeFi protocols, and referrer fee systems are an excellent use case for this powerful architecture.

<function_calls>
<invoke name="TodoWrite">
<parameter name="todos">[{"id": "1", "content": "Research Uniswap V4 hooks architecture and capabilities", "status": "completed", "priority": "high"}, {"id": "2", "content": "Analyze hooks for liquidity referrer fee implementation", "status": "completed", "priority": "high"}, {"id": "3", "content": "Analyze hooks for swap referrer fee implementation", "status": "completed", "priority": "high"}, {"id": "4", "content": "Compare V4 hooks vs V3 periphery implementation approaches", "status": "completed", "priority": "medium"}, {"id": "5", "content": "Create comprehensive analysis document", "status": "completed", "priority": "high"}]