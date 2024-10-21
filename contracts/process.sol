// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

contract Process_Contract {
    enum State {
        Closed,
        Open,
        Completed
    }

    modifier isAccessible(
        uint instanceID,
        string memory _activity,
        string memory _role
    ) {
        require(
            intances[instanceID].state[_activity] == State.Open,
            "Activity is not open"
        );
        require(
            compareStrings(
                intances[instanceID].addressToRole[msg.sender],
                _role
            ),
            "Caller does not have the required role"
        );
        _;
    }

    struct LocalData {
        uint supplies; // Number of supplies
    }

    struct GlobalData {
        uint256 basePrice; // Base price in wei
        uint256 demandFactor; // Price increase factor (in percentage, e.g., 10 for 10%)
        uint256 requestCount; // Number of requests made
    }

    struct Instance {
        LocalData localData;
        mapping(string => State) state;
        mapping(address => string) addressToRole;
    }

    mapping(uint => Instance) public intances;

    uint public instancesCount;

    GlobalData public globalData;

    constructor() {
    }

    function setResources(
        uint instanceID,
        string[] memory _roles,
        address[] memory _addresses
    ) public {
        require(
            _roles.length == _addresses.length,
            "Roles and addresses arrays must be of the same length"
        );

        for (uint i = 0; i < _addresses.length; i++) {
            intances[instanceID].addressToRole[_addresses[i]] = _roles[i];
        }
    }

    function setResource(
        uint instanceID,
        string memory _role,
        address _address
    ) public {
        intances[instanceID].addressToRole[_address] = _role;
    }

    function setState(
        uint instanceID,
        string memory _activity,
        uint8 _state
    ) public {
        require(_state <= 3, "Not Valid State");
        intances[instanceID].state[_activity] = State(_state);
    }

    function getState(
        uint instanceID,
        string memory _activity
    ) public view returns (State) {
        return intances[instanceID].state[_activity];
    }

    //Reset data each new epoch
    function resetData(uint instanceID) public {
        intances[instanceID].localData.supplies = 1;
        intances[instanceID].localData.requestCount = 0;
    }

    function compareStrings(
        string memory a,
        string memory b
    ) internal pure returns (bool) {
        return keccak256(abi.encodePacked(a)) == keccak256(abi.encodePacked(b));
    }

    function calculatePrice() internal view returns (uint256) {
        
        uint256 priceIncrease;

        // Check if there are multiple requests
        if (globalData.requestCount > 1) {
            // Calculate the price increase based on the number of requests
            priceIncrease =
                (globalData.basePrice *
                    globalData.demandFactor *
                    globalData.requestCount) /
                100;
        } else {
            priceIncrease = 0; // No increase if only one request
        }

        // Calculate the final price
        return globalData.basePrice + priceIncrease;
    }

    function PurchaseOrder(
        uint instanceID
    ) public isAccessible("PurchaseOrder", "Customer") {

        if (intances[instanceID].localData.supplies > 0) {

            intances[instanceID].state["ConfirmOrder"] = State.Open;

        } else {

            intances[instanceID].state["RestockRequest"] = State.Open;

        }

        intances[instanceID].state["PurchaseOrder"] = State.Completed;
    }

    function ConfirmOrder(
        uint instanceID
    ) public isAccessible("PurchaseOrder", "Customer") {

        intances[instanceID].state["ConfirmOrder"] = State.Completed;

    }

    function RestockRequest(
        uint instanceID
    ) public isAccessible("PurchaseOrder", "Customer") returns (uint256) {

        intances[instanceID].localData.requestCount++;

        uint256 newPrice = calculatePrice();

        intances[instanceID].state["ConfirmRestock"] = State.Open;

        intances[instanceID].state["CancelOrder"] = State.Open;

        intances[instanceID].state["RestockRequest"] = State.Completed;

        return newPrice;
    }

    function ConfirmRestock(
        uint instanceID
    ) public isAccessible("PurchaseOrder", "Customer") {

        intances[instanceID].localData.supplies = 1;

        intances[instanceID].state["ConfirmOrder"] = State.Open;

        intances[instanceID].state["ConfirmRestock"] = State.Completed;
    }
}
