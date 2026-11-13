// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

// Minimal self-contained test base (no forge-std dependency, so the suite builds offline with only `forge`).

interface Vm {
    struct Log { bytes32[] topics; bytes data; address emitter; }
    function prank(address) external;
    function startPrank(address) external;
    function stopPrank() external;
    function expectRevert(bytes calldata) external;
    function expectRevert() external;
    function warp(uint256) external;
    function deal(address, uint256) external;
    function createSelectFork(string calldata) external returns (uint256);
    function createSelectFork(string calldata, uint256) external returns (uint256);
    function envOr(string calldata, string calldata) external view returns (string memory);
    function envOr(string calldata, uint256) external view returns (uint256);
    function recordLogs() external;
    function getRecordedLogs() external returns (Log[] memory);
    function label(address, string calldata) external;
}

abstract contract TestBase {
    bool public IS_TEST = true;
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function _u(uint256 v) internal pure returns (string memory) {
        if (v == 0) return "0";
        uint256 j = v; uint256 len;
        while (j != 0) { len++; j /= 10; }
        bytes memory b = new bytes(len);
        while (v != 0) { len--; b[len] = bytes1(uint8(48 + v % 10)); v /= 10; }
        return string(b);
    }

    function assertEq(uint256 a, uint256 b, string memory m) internal pure {
        if (a != b) revert(string.concat(m, " expected=", _u(b), " actual=", _u(a)));
    }
    function assertEq(address a, address b, string memory m) internal pure { if (a != b) revert(m); }
    function assertTrue(bool c, string memory m) internal pure { if (!c) revert(m); }
    function assertGe(uint256 a, uint256 b, string memory m) internal pure {
        if (a < b) revert(string.concat(m, " expected>=", _u(b), " actual=", _u(a)));
    }
}
