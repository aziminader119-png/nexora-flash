// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ForkArbBase} from "./ForkArbBase.sol";

// Addresses below are the publicly documented deployments. setUp() fails loudly if any of them has no code on
// the forked chain, so a wrong or retired address can never silently pass.

address constant AAVE_POOL_L2 = 0x794a61358D6845594F94dc1DB02A252b5b4814aD; // Arbitrum, Optimism, Polygon
address constant BALANCER_V2_VAULT = 0xBA12222222228d8Ba445958a75a0704d566BF2C8;
address constant UNI_V3_SWAPROUTER = 0xE592427A0AEce92De3Edee1F18E0157C05861564; // SwapRouter v1 (deadline)
address constant UNI_V3_QUOTERV2 = 0x61fFE014bA17989E743c5F6cB21bF9697530B21e;

contract ForkBaseTest is ForkArbBase {
    function net() internal pure override returns (Net memory) {
        return Net({
            rpcEnv: "BASE_RPC_URL", rpcDefault: "https://base-rpc.publicnode.com", chainId: 8453,
            stable: 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913, wrapped: 0x4200000000000000000000000000000000000006,
            aavePool: 0xA238Dd80C259a72e81d7e4664a9801593F98d1c5, balancerVault: BALANCER_V2_VAULT,
            morpho: 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb,
            v2Router: 0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24, v2Factory: 0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6,
            v3Router: 0x2626664c2603336E57B271c5C0b26F421741e481, v3Kind: 2, // SwapRouter02 (no deadline field)
            quoter: 0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a,
            buyV3Fee: 0
        });
    }
    function test_morpho_roundTrip() public { _roundTrip(n.morpho, n.morpho, 0); }
    function test_balancer_roundTrip() public { _roundTrip(n.balancerVault, n.balancerVault, _balancerFee()); }
}

contract ForkBNBTest is ForkArbBase {
    function net() internal pure override returns (Net memory) {
        return Net({
            rpcEnv: "BSC_RPC_URL", rpcDefault: "https://bsc-rpc.publicnode.com", chainId: 56,
            stable: 0x55d398326f99059fF775485246999027B3197955, wrapped: 0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c,
            aavePool: 0x6807dc923806fE8Fd134338EABCA509979a7e0cB, balancerVault: address(0), morpho: address(0),
            v2Router: 0x10ED43C718714eb63d5aA57B78B54704E256024E, v2Factory: 0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73, // PancakeSwap V2
            v3Router: 0x1b81D678ffb9C0263b24A97847620C99d213eB14, v3Kind: 1, // PancakeSwap V3 SwapRouter (deadline)
            quoter: 0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997,
            buyV3Fee: 0
        });
    }
}

contract ForkArbitrumTest is ForkArbBase {
    function net() internal pure override returns (Net memory) {
        return Net({
            rpcEnv: "ARBITRUM_RPC_URL", rpcDefault: "https://arbitrum-one-rpc.publicnode.com", chainId: 42161,
            stable: 0xaf88d065e77c8cC2239327C5EDb3A432268e5831, wrapped: 0x82aF49447D8a07e3bd95BD0d56f35241523fBab1,
            aavePool: AAVE_POOL_L2, balancerVault: BALANCER_V2_VAULT, morpho: address(0),
            v2Router: 0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24, v2Factory: 0xf1D7CC64Fb4452F05c498126312eBE29f30Fbcf9,
            v3Router: UNI_V3_SWAPROUTER, v3Kind: 1, quoter: UNI_V3_QUOTERV2,
            buyV3Fee: 0
        });
    }
    function test_balancer_roundTrip() public { _roundTrip(n.balancerVault, n.balancerVault, _balancerFee()); }
}

contract ForkOptimismTest is ForkArbBase {
    function net() internal pure override returns (Net memory) {
        return Net({
            rpcEnv: "OPTIMISM_RPC_URL", rpcDefault: "https://optimism-rpc.publicnode.com", chainId: 10,
            stable: 0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85, wrapped: 0x4200000000000000000000000000000000000006,
            aavePool: AAVE_POOL_L2, balancerVault: BALANCER_V2_VAULT, morpho: address(0),
            v2Router: 0x4A7b5Da61326A6379179b40d00F57E5bbDC962c2, v2Factory: 0x0c3c1c532F1e39EdF36BE9Fe0bE1410313E074Bf,
            v3Router: UNI_V3_SWAPROUTER, v3Kind: 1, quoter: UNI_V3_QUOTERV2,
            buyV3Fee: 3000
        });
    }
    function test_balancer_roundTrip() public { _roundTrip(n.balancerVault, n.balancerVault, _balancerFee()); }
}

contract ForkPolygonTest is ForkArbBase {
    function net() internal pure override returns (Net memory) {
        return Net({
            rpcEnv: "POLYGON_RPC_URL", rpcDefault: "https://polygon-bor-rpc.publicnode.com", chainId: 137,
            stable: 0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359, wrapped: 0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270,
            aavePool: AAVE_POOL_L2, balancerVault: BALANCER_V2_VAULT, morpho: address(0),
            v2Router: 0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff, v2Factory: 0x5757371414417b8C6CAad45bAeF941aBc7d3Ab32, // QuickSwap V2
            v3Router: UNI_V3_SWAPROUTER, v3Kind: 1, quoter: UNI_V3_QUOTERV2,
            buyV3Fee: 0
        });
    }
    function test_balancer_roundTrip() public { _roundTrip(n.balancerVault, n.balancerVault, _balancerFee()); }
}
