const fs = require('fs');

// Function to count relative appearances of specific instance pairs within each entry
function countRelativeOrderPairs(data) {
    const pairCounts = {
        "1_vs_3": { "1_before_3": 0, "3_before_1": 0 },
        "2_vs_4": { "2_before_4": 0, "4_before_2": 0 }
    };

    // Loop through each entry in the data array
    data.forEach((entry, index) => {
        // Ensure the entry has an 'instances' array
        if (!entry.instances || !Array.isArray(entry.instances)) {
            console.error(`Warning: Entry at index ${index} does not contain an 'instances' array.`);
            return;
        }

        // Filter for instances 1 and 3
        const instances1and3 = entry.instances.filter(item => item.instanceID === 1 || item.instanceID === 3);
        if (instances1and3.length === 2) { // Ensure both are present
            if (instances1and3[0].instanceID === 1) {
                pairCounts["1_vs_3"]["1_before_3"]++;
            } else {
                pairCounts["1_vs_3"]["3_before_1"]++;
            }
        }

        // Filter for instances 2 and 4
        const instances2and4 = entry.instances.filter(item => item.instanceID === 2 || item.instanceID === 4);
        if (instances2and4.length === 2) { // Ensure both are present
            if (instances2and4[0].instanceID === 2) {
                pairCounts["2_vs_4"]["2_before_4"]++;
            } else {
                pairCounts["2_vs_4"]["4_before_2"]++;
            }
        }
    });

    return pairCounts;
}

// Example usage: Load JSON data from file and call the function
const jsonData = JSON.parse(fs.readFileSync('/Users/hassanatwi/transparent-ordering/data/randomLog.json', 'utf8'));
const result = countRelativeOrderPairs(jsonData);

console.log("Count of each pair competing for relative order:");
console.log(result);
