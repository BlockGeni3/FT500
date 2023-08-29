const ethers = require('ethers');
const fs = require('fs');
const { promisify } = require('util');
const appendFile = promisify(fs.appendFile);
require("dotenv").config();

const friendsAddress = '0xCF205808Ed36593aa40a44F10c7f7C2F67d4A4d4';
const provider = new ethers.JsonRpcProvider(`https://rpc.ankr.com/base`);
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY);
const account = wallet.connect(provider);
const startBalance = provider.getBalance(wallet.address);
const friends = new ethers.Contract(
  friendsAddress,
  [
    'function buyShares(address arg0, uint256 arg1)',
    'function getBuyPriceAfterFee(address sharesSubject, uint256 amount) public view returns (uint256)',
    'event Trade(address trader, address subject, bool isBuy, uint256 shareAmount, uint256 ethAmount, uint256 protocolEthAmount, uint256 subjectEthAmount, uint256 supply)',
    'function sharesSupply(address sharesSubject) public view returns (uint256)',
    'function getSellPriceAfterFee(address sharesSubject, uint256 amount) public view returns (uint256)'
  ],
  account
);
const filter = friends.filters.Trade(null, null, null, null, null, null, null, null);
let cachedGasPrice = null;
let lastGasFetch = 0;
let baseGasPrice = null;
const balanceSet = new Set();

async function fetchGasPrice() {
  if (Date.now() - lastGasFetch > 1 * 60 * 1000) { // Fetch every 1 minute instead of 5
    const feeData = await provider.getFeeData();
    if (feeData && feeData.maxFeePerGas) {
      baseGasPrice =  feeData.maxFeePerGas;
      cachedGasPrice = parseInt((parseInt(feeData.maxFeePerGas) * 110) / 100);
      lastGasFetch = Date.now();
    } else {
      console.error('Unable to get fee data or maxFeePerGas.');
    }
  }
}

function shouldActOnEvent(event, weiBalance) {
  const amigo = event.args[1];

  if (event.args[2] !== true) return false;
  if (event.args[7] > 1n && (event.args[7] > 4n || event.args[0] !== event.args[1])) return false;
  if (balanceSet.has(weiBalance)) return false; // using a Set instead of an Array
  // if (weiBalance > 95000000000000000 && weiBalance < 105000000000000000) return false;
  if (weiBalance <= 5000000000000000) {
    const ethBalance = (Number(weiBalance) * 0.000000000000000001).toFixed(4).toString() + " ETH";
    console.log(`No Money No Honey: `, amigo, ethBalance);
  }
  // Store the last 20 balances
  balanceSet.add(weiBalance);
  if (balanceSet.size > 20) balanceSet.delete([...balanceSet][0]);

  return true;
}

async function handleEvent(event) {
  const amigo = event.args[1];
  const weiBalance = await provider.getBalance(amigo);
  const qty = determineQty(weiBalance);
  const [currentBalance, nonce, sellPrice, buyPrice] = await Promise.all([
    provider.getBalance(wallet.address), 
    provider.getTransactionCount(wallet.address, 'pending'),
    friends.getSellPriceAfterFee(amigo, 1),
    friends.getBuyPriceAfterFee(amigo, qty)
  ]);
  

  if (!shouldActOnEvent(event, weiBalance)) return;

  await fetchGasPrice(); 

  let finalGasPrice = cachedGasPrice;

  // Adjust gas price based on buy price
  if(buyPrice < baseGasPrice) {
    finalGasPrice = (cachedGasPrice * 101) / 100;
  } else {
    finalGasPrice = (cachedGasPrice * 150) / 100; 
  }
  
  // Add this condition to explicitly skip if qty is 0
  if (qty === 0) {
    console.log('Skipped buying shares as the quantity is zero.');
    return;
  }

  // Skip if cant be sold
  if(Number(sellPrice) === 0) {
    console.log('Skipped buying shares as they cant be sold.');
    return;
  }
  
  // Add this condition to explicitly skip if qty is 0
  if (qty > 0 && buyPrice === 0) {
    console.log('Skipped buying shares as they look botted.');
    return;
  }

  if ((qty < 2 && buyPrice > 2000000000000000) || buyPrice > 10000000000000000) return;

  if(currentBalance < startBalance && Number(currentBalance) <= (Number(startBalance) / 2)) {
    console.log('Balance hit half way point shutting down');
    process.exit();
  }

  if (buyPrice < Number(finalGasPrice)) {
    console.log('Skipped buying shares as they cost less than the gas fee.');
    return;
  }

  if(buyPrice > 0) {
    try {
      const tx = await friends.buyShares(amigo, qty, {value: buyPrice, gasPrice: finalGasPrice, nonce: nonce});
      fs.writeFileSync('./buys.txt', `\n${amigo}, ${buyPrice}`, {flag: 'a'});
      console.log("--------###BUY###----------");
      console.log({
        qty: qty,
        buyPrice: (Number(buyPrice) * 0.000000000000000001).toFixed(4).toString() + " ETH",
        sellPrice: (Number(sellPrice) * 0.000000000000000001).toFixed(4).toString() + " ETH",
        finalGasPrice: finalGasPrice,
        currentBalance: currentBalance.toString(),
        nonce: nonce
      });
      const receipt = await tx.wait();
      console.log('Transaction Mined:', receipt.blockNumber);
      console.log("---------------------------");
    } catch (error) {
      let outMessage = error.message.includes("error=") ? error.message.split("error=")[1].split(', {')[0] : error.message;
      console.log('Transaction Failed:', outMessage);
    }
  }
}

function determineQty(weiBalance) {
  if (weiBalance < 30000000000000000) return 0;
  if (weiBalance < 90000000000000000) return 1;
  if (weiBalance < 900000000000000000) return 2;
  return 3;
}

const run = () => {
  friends.on(filter, handleEvent);
};

try {
  run();
} 
catch (error) {
  let outMessage = error.message.includes("error=") ? error.message.split("error=")[1].split(', {')[0] : error.message;
  console.log('Transaction Failed:', outMessage);
}

process.on('uncaughtException', error => {
  console.error('Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Promise Rejection:', reason);
});
