pragma solidity ^0.8.0;


contract ConsensusContract {
    // processInstance public process;
    address public workflow_address;

    uint public block_interval = 2;
    uint public index_block = 0;

    struct Interaction {
        uint instance;
        address sender;
        address receiver;
        string task;
        uint id;
        uint block_number;
        int32 domain;
    }

    Interaction[] public pending_interactions;
    uint public pending_interactions_count = 0;

    uint[] public ordered_interactions;

    address[] public orderers;
    uint public orderers_count = 0;

    int32 public domain_count = 0;
    int32[] public conflicting_domains;

    uint public vote_count = 0;

    event Conflict(int32 indexed domain, uint[2] transactions);

    modifier duringVote() {
        require(
            index_block != 0 && block.number >= index_block + block_interval,
            "Can't vote now."
        );
        _;
    }

    function submitInteraction(uint instance, string memory task) external {
        if (index_block == 0) {
            index_block = block.number;
        }

        require(
            block.number < index_block + block_interval,
            "Transactions list is locked."
        );

        // address[] memory participants = workflow_contract.getParticipantsByTask(instance, task);

        pending_interactions.push(
            Interaction({
                instance: instance,
                sender: msg.sender,
                receiver: msg.sender,
                task: task,
                id: pending_interactions_count++,
                block_number: block.number,
                domain: -1
            })
        );

        update_orderers();
    }

    function update_orderers() internal {
        // Selecting strategy for selecting orderers
        intermediate_orderer();
    }

    function removeOrderersInDomain(int32 domain) internal {
        uint i = 0;
        while (i < orderers.length) {
            // Check if the sender or receiver is part of the conflicting domain
            for (uint j = 0; j < pending_interactions.length; j++) {
                if (
                    pending_interactions[j].domain == domain &&
                    (pending_interactions[j].sender == orderers[i] ||
                        pending_interactions[j].receiver == orderers[i])
                ) {
                    // Remove orderer by shifting the array elements
                    orderers[i] = orderers[orderers.length - 1];
                    orderers.pop();
                    orderers_count--;
                    i--; // Adjust index since we modified the array
                    break;
                }
            }
            i++;
        }
    }

    function intermediate_orderer() internal {
        for (uint i = 0; i < pending_interactions.length; i++) {
            address sender = pending_interactions[i].sender;
            address receiver = pending_interactions[i].receiver;

            // Check for sender in the rest of the interactions
            for (uint j = 0; j < pending_interactions.length; j++) {
                if (i == j) {
                    continue;
                }

                // Check if the sender matches either the sender or receiver of another interaction
                if (
                    sender == pending_interactions[j].sender ||
                    sender == pending_interactions[j].receiver
                ) {
                    if (!is_orderer(sender)) {
                        orderers.push(sender);
                        orderers_count++;
                    }
                    break; // No need to check further once sender is added
                }
            }

            // Check for receiver in the rest of the interactions
            for (uint j = 0; j < pending_interactions.length; j++) {
                if (i == j) {
                    continue;
                }

                // Check if the receiver matches either the sender or receiver of another interaction
                if (
                    receiver == pending_interactions[j].sender ||
                    receiver == pending_interactions[j].receiver
                ) {
                    if (!is_orderer(receiver)) {
                        orderers.push(receiver);
                        orderers_count++;
                    }
                    break; // No need to check further once receiver is added
                }
            }
        }
    }

    function is_orderer(address _address) internal view returns (bool) {
        for (uint i = 0; i < orderers.length; i++) {
            if (orderers[i] == _address) {
                return true;
            }
        }
        return false;
    }

    function is_conflicting(int32 domain) internal view returns (bool) {
        for (uint i = 0; i < conflicting_domains.length; i++) {
            if (int32(conflicting_domains[i]) == domain) {
                return true;
            }
        }
        return false;
    }

    function orderInteraction(
        uint[] calldata indicesToReorder
    ) external duringVote {
        require(
            indicesToReorder.length > 1,
            "Need at least two indices to reorder"
        );

        // Generate domains if we did not do it yet
        if (domain_count == 0) {
            generate_domains();
        }

        vote_count++;

        // Validate all provided indices are within bounds and not duplicated
        bool[] memory reorderedFlags = new bool[](pending_interactions.length);
        for (uint i = 0; i < indicesToReorder.length; i++) {
            uint index = indicesToReorder[i];
            require(
                index < pending_interactions.length,
                "Invalid interaction ID"
            );
            require(
                !reorderedFlags[index],
                "Duplicate interaction ID in the order"
            );
            reorderedFlags[index] = true;
        }

        // Check for conflicts and store interactions in ordered_interactions
        uint anchorIndex = 0;
        uint existingIndex = 0;

        for (uint i = 0; i < indicesToReorder.length; i++) {
            uint currentIndex = indicesToReorder[i];

            require(
                !is_conflicting(pending_interactions[currentIndex].domain),
                "Interaction is in a conflicting domain."
            );

            // Check if the interaction exists in ordered_interactions
            bool existsInOrdered = false;
            for (uint j = 0; j < ordered_interactions.length; j++) {
                if (ordered_interactions[j] == currentIndex) {
                    existsInOrdered = true;
                    existingIndex = j;
                    break;
                }
            }

            // If interaction found, check for conflicts
            if (existsInOrdered) {
                if (existingIndex >= anchorIndex) {
                    anchorIndex = existingIndex;
                } else {
                    // Conflict detected

                    Interaction
                        memory conflictingInteraction1 = pending_interactions[
                            ordered_interactions[anchorIndex]
                        ];
                    Interaction
                        memory conflictingInteraction2 = pending_interactions[
                            ordered_interactions[existingIndex]
                        ];

                    // Flag conflicting domain
                    conflicting_domains.push(conflictingInteraction1.domain);

                    // Remove orderers involved in this domain
                    removeOrderersInDomain(conflictingInteraction1.domain);

                    emit Conflict(
                        conflictingInteraction1.domain,
                        [conflictingInteraction1.id, conflictingInteraction2.id]
                    );

                    break;
                }
            } else {
                // Add interaction to ordered_interactions if it doesn't exist
                ordered_interactions.push(currentIndex);
            }
        }

        // If all orderers votes completed we execute the interactions
        if (vote_count == orderers_count) {
            executeInteractions();
        }
    }

    function executeInteractions() internal {
        for (uint i = 0; i < ordered_interactions.length; i++) {
            // execute(pending_interactions[ordered_interactions[i]]);
        }

        reset_data();
    }

    // Function to generate domains based on common senders or receivers
    function generate_domains() internal {
        for (uint i = 0; i < pending_interactions.length; i++) {
            int32 new_domain = pending_interactions[i].domain;
            if (new_domain == -1) {
                new_domain = domain_count++; // Assign a new domain if the interaction doesn't have one
                pending_interactions[i].domain = new_domain;
            }

            bool matched = false;

            for (uint j = 0; j < pending_interactions.length; j++) {
                if (i != j) {
                    Interaction
                        memory target_interaction = pending_interactions[i];
                    Interaction memory next_interaction = pending_interactions[
                        j
                    ];

                    address target_interaction_sender = target_interaction
                        .sender;
                    address target_interaction_receiver = target_interaction
                        .receiver;

                    address next_interaction_sender = next_interaction.sender;
                    address next_interaction_receiver = next_interaction
                        .receiver;

                    // Check if the sender or receiver matches for the interactions
                    if (
                        target_interaction_sender == next_interaction_sender ||
                        target_interaction_sender ==
                        next_interaction_receiver ||
                        target_interaction_receiver ==
                        next_interaction_sender ||
                        target_interaction_receiver == next_interaction_receiver
                    ) {
                        pending_interactions[j].domain = new_domain; // Assign the same domain
                        matched = true;
                    }
                }
            }

            // If no match is found, we simply proceed without any further actions
            if (!matched) {
                pending_interactions[i].domain = -1; // Set to -1 to indicate no matching domain
                ordered_interactions.push(i); // Push isolated interactions
            }
        }
    }
    
    function reset_data() internal {
        delete orderers;
        delete pending_interactions;
        delete ordered_interactions;

        domain_count = 0;
        orderers_count = 0;
        vote_count = 0;
        index_block = 0;
    }
}
