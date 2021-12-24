const axios = require("axios");
const { cyan, green, magenta, red, yellow } = require("chalk");
const { Api } = require("eosjs/dist/eosjs-api");
const { JsonRpc } = require("eosjs/dist/eosjs-jsonrpc");
const { JsSignatureProvider } = require("eosjs/dist/eosjs-jssig");
const { PrivateKey } = require("eosjs/dist/eosjs-key-conversions");
const { dateToTimePointSec, timePointSecToDate } = require("eosjs/dist/eosjs-serialize");
const _ = require("lodash");
const fetch = require("node-fetch");
const { TextDecoder, TextEncoder } = require("util");

require("dotenv").config();

const WAX_ENDPOINTS = _.shuffle([
	// "https://api.wax.greeneosio.com",
	"https://api.waxsweden.org",
	"https://wax.cryptolions.io",
	"https://wax.eu.eosamsterdam.net",
	"https://api-wax.eosarabia.net",
	"https://wax.greymass.com",
	"https://wax.pink.gg",
]);

const ATOMIC_ENDPOINTS = _.shuffle([
	"https://aa.wax.blacklusion.io",
	"https://wax-atomic-api.eosphere.io",
	"https://wax.api.atomicassets.io",
	"https://wax.blokcrafters.io",
]);

const Configs = {
	autoWithdraw: false,
	withdrawThresholds: [],
	maxWithdraw: [],

	autoDeposit: false,
	depositThresholds: [],
	maxDeposit: [],

	WAXEndpoints: [...WAX_ENDPOINTS],
};

async function shuffleEndpoints() {
	// shuffle endpoints to avoid spamming a single one
	Configs.WAXEndpoints = _.shuffle(WAX_ENDPOINTS);
}

/**
 *
 * @param {number} t in seconds
 * @returns {Promise<void>}
 */
async function waitFor(t) {
	return new Promise(resolve => setTimeout(() => resolve(), t * 1e3));
}

function parseRemainingTime(millis) {
	const diff = Math.floor(millis / 1e3);
	const hours = Math.floor(diff / 3600);
	const minutes = Math.floor((diff % 3600) / 60);
	const seconds = Math.floor((diff % 3600) % 60);
	const time = [
		hours > 0 && `${hours.toString().padStart(2, "0")} hours`,
		minutes > 0 && `${minutes.toString().padStart(2, "0")} minutes`,
		seconds > 0 && `${seconds.toString().padStart(2, "0")} seconds`,
	]
		.filter(n => !!n)
		.join(", ");

	return time;
}

function logTask(...message) {
	console.log(`${yellow("Task")}`, ...message);
	console.log("-".repeat(32));
}

async function transact(config) {
	const { DEV_MODE } = process.env;
	if (DEV_MODE == 1) {
		return;
	}

	try {
		const endpoint = _.sample(Configs.WAXEndpoints);
		const rpc = new JsonRpc(endpoint, { fetch });

		const accountAPI = new Api({
			rpc,
			signatureProvider: new JsSignatureProvider(config.privKeys),
			textEncoder: new TextEncoder(),
			textDecoder: new TextDecoder(),
		});

		const info = await rpc.get_info();
		const subId = info.head_block_id.substr(16, 8);
		const prefix = parseInt(subId.substr(6, 2) + subId.substr(4, 2) + subId.substr(2, 2) + subId.substr(0, 2), 16);

		const transaction = {
			expiration: timePointSecToDate(dateToTimePointSec(info.head_block_time) + 3600),
			ref_block_num: 65535 & info.head_block_num,
			ref_block_prefix: prefix,
			actions: await accountAPI.serializeActions(config.actions),
		};

		const abis = await accountAPI.getTransactionAbis(transaction);
		const serializedTransaction = accountAPI.serializeTransaction(transaction);

		const accountSignature = await accountAPI.signatureProvider.sign({
			chainId: info.chain_id,
			abis,
			requiredKeys: config.privKeys.map(pk => PrivateKey.fromString(pk).getPublicKey().toString()),
			serializedTransaction,
		});

		const pushArgs = { ...accountSignature };
		const result = await accountAPI.pushSignedTransaction(pushArgs);

		console.log(green(result.transaction_id));
	} catch (error) {
		console.log(red(error.message));
	}
}

async function fetchTable(contract, table, scope, bounds, tableIndex, index = 0) {
	if (index >= Configs.WAXEndpoints.length) {
		return [];
	}

	try {
		const endpoint = Configs.WAXEndpoints[index];
		const rpc = new JsonRpc(endpoint, { fetch });

		const data = await Promise.race([
			rpc.get_table_rows({
				json: true,
				code: contract,
				scope: scope,
				table: table,
				lower_bound: bounds,
				upper_bound: bounds,
				index_position: tableIndex,
				key_type: "i64",
				limit: 1000,
			}),
			waitFor(5).then(() => null),
		]);

		if (!data) {
			throw new Error();
		}

		return data.rows;
	} catch (error) {
		return await fetchTable(contract, table, scope, bounds, tableIndex, index + 1);
	}
}

async function fetchTools(account) {
	const tools = await fetchTable("spacecraftxc", "stakedassets", account, null, 1);
	return _.orderBy(tools, ["template_id", r => new Date(r.ready_at).getTime()], ["asc", "asc"]);
}

async function fetchAccount(account) {
	return await fetchTable("spacecraftxc", "users", "spacecraftxc", account, 1);
}

function makeToolClaimAction(account, toolId) {
	return {
		account: "spacecraftxc",
		name: "getreward",
		authorization: [{ actor: account, permission: "active" }],
		data: { asset_id: toolId, owner: account },
	};
}

function makeToolRepairAction(account, toolId, payment) {
	return {
		account: "spacecraftxc",
		name: "repairasset",
		authorization: [{ actor: account, permission: "active" }],
		data: { owner: account, asset_id: toolId, dark_matter_payment: payment },
	};
}

function makeRecoverAction(account, waves) {
	return {
		account: "spacecraftxc",
		name: "buyenergy",
		authorization: [{ actor: account, permission: "active" }],
		data: { waves_payment: waves, owner: account },
	};
}

function makeWithdrawAction(account, quantity) {
	return {
		account: "spacecraftxc",
		name: "withdraw",
		authorization: [{ actor: account, permission: "active" }],
		data: { owner: account, quantity },
	};
}

function makeDepositAction(account, quantity) {
	return {
		account: "spacecraftxt",
		name: "transfer",
		authorization: [{ actor: account, permission: "active" }],
		data: { from: account, to: "spacecraftxc", quantity, memo: "deposit" },
	};
}

async function recoverEnergy(account, privKey) {
	shuffleEndpoints();

	const { RECOVER_THRESHOLD, MAX_WAVES_CONSUMPTION, DELAY_MIN, DELAY_MAX } = process.env;
	const delayMin = parseFloat(DELAY_MIN) || 4;
	const delayMax = parseFloat(DELAY_MAX) || 10;
	const maxConsumption = parseFloat(MAX_WAVES_CONSUMPTION) || 100;
	const threshold = parseFloat(RECOVER_THRESHOLD) || 50;

	logTask(`Recovering Energy`);
	console.log(`Fetching account ${cyan(account)}`);
	const [accountInfo] = await fetchAccount(account);

	if (!accountInfo) {
		console.log(`${red("Error")} Account ${cyan(account)} not found`);
		return;
	}

	const { energy, waves } = accountInfo;
	const percentage = 100 * (energy / 1000);

	if (percentage > threshold) {
		console.log(
			`${yellow("Info")}`,
			`Account ${cyan(account)} doesn't need to recover`,
			`(energy ${yellow(energy)} / ${yellow(1000)})`,
			magenta(`(${_.round((energy / 1000) * 100, 2)}%)`)
		);
		return;
	}

	const wavesBalance = parseFloat(waves.quantity) || 0;

	if (wavesBalance < 1) {
		console.log(`${yellow("Warning")} Account ${cyan(account)} doesn't have waves to recover energy`);
		return;
	}

	const wavesNeeded = Math.min(Math.floor((1000 - energy) / 10), Math.floor(Math.min(maxConsumption, wavesBalance)));
	const delay = _.round(_.random(delayMin, delayMax, true), 2);

	console.log(
		`\tRecovering ${yellow(wavesNeeded * 10)} energy`,
		`by consuming ${yellow(wavesNeeded)} Waves`,
		`(energy ${yellow(energy)} / ${yellow(1000)})`,
		magenta(`(${_.round((energy / 1000) * 100, 2)}%)`),
		`(after a ${Math.round(delay)}s delay)`
	);
	const actions = [makeRecoverAction(account, wavesNeeded)];

	await waitFor(delay);
	await transact({ account, privKeys: [privKey], actions });
}

async function repairTools(account, privKey) {
	shuffleEndpoints();

	const { REPAIR_THRESHOLD, DELAY_MIN, DELAY_MAX } = process.env;
	const delayMin = parseFloat(DELAY_MIN) || 4;
	const delayMax = parseFloat(DELAY_MAX) || 10;
	const threshold = parseFloat(REPAIR_THRESHOLD) || 50;

	logTask(`Repairing Tools`);
	console.log(`Fetching account ${cyan(account)}`);
	const [accountInfo] = await fetchAccount(account);

	if (!accountInfo) {
		console.log(`${red("Error")} Account ${cyan(account)} not found`);
		return;
	}

	console.log(`Fetching tools for account ${cyan(account)}`);
	const tools = await fetchTools(account);

	const repeairables = tools.filter(({ strength, basic_strength }) => {
		const percentage = 100 * (strength / basic_strength);
		return percentage < threshold;
	});

	console.log(`Found ${yellow(tools.length)} tools / ${yellow(repeairables.length)} tools ready to be repaired`);

	const { dark_matter } = accountInfo;
	let darkMatterBalance = parseFloat(dark_matter.quantity);

	if (repeairables.length > 0) {
		const delay = _.round(_.random(delayMin, delayMax, true), 2);

		const actions = repeairables
			.map(tool => {
				const repairCost = (tool.basic_strength - tool.strength) / 10;

				if (repairCost > darkMatterBalance) {
					console.log(
						`${yellow("Warning")}`,
						`Account ${cyan(account)} doesn't have enough dark matter to repair`,
						`tool (${yellow(tool.asset_id)})`
					);
					return null;
				}
				darkMatterBalance -= repairCost;

				console.log(
					`\tRepairing`,
					`(${yellow(tool.asset_id)})`,
					`(strength ${yellow(tool.strength)} / ${yellow(tool.basic_strength)})`,
					magenta(`(${_.round((tool.strength / tool.basic_strength) * 100, 2)}%)`),
					`using (${repairCost.toLocaleString("en", { maximumSignificantDigits: 4 })} SCID)`,
					`(after a ${Math.round(delay)}s delay)`
				);

				return makeToolRepairAction(account, tool.asset_id, Math.round(repairCost * 1e4));
			})
			.filter(a => !!a);

		if (actions.length) {
			console.log("Repairing Tools");

			await waitFor(delay);
			await transact({ account, privKeys: [privKey], actions });
		}
	}
}

async function useTools(account, privKey) {
	shuffleEndpoints();

	const { DELAY_MIN, DELAY_MAX } = process.env;
	const delayMin = parseFloat(DELAY_MIN) || 4;
	const delayMax = parseFloat(DELAY_MAX) || 10;

	logTask(`Using Tools`);
	console.log(`Fetching tools for account ${cyan(account)}`);
	const tools = await fetchTools(account);

	console.log(`Found ${yellow(tools.length)} tools`);

	const delay = _.round(_.random(delayMin, delayMax, true), 2);

	const actions = tools
		.map(tool => {
			const nextClaim = new Date(new Date(`${tool.ready_at}Z`).getTime() + 3.6e6);
			if (nextClaim.getTime() > Date.now()) {
				console.log(
					`\t${yellow("Notice")} Tool`,
					`(${yellow(tool.asset_id)})`,
					`still in cooldown period`,
					yellow(parseRemainingTime(nextClaim.getTime() - Date.now()))
				);
				return null;
			}

			if (tool.strength_usage >= tool.strength) {
				console.log(
					`\t${yellow("Warning")} Tool`,
					`(${yellow(tool.asset_id)})`,
					`does not have enough strength`,
					`(strength ${yellow(tool.strength)} / ${yellow(tool.basic_strength)})`
				);
				return null;
			}

			console.log(
				`\tClaiming with`,
				`(${yellow(tool.asset_id)})`,
				`(strength ${yellow(tool.strength)} / ${yellow(tool.basic_strength)})`,
				magenta(`(${_.round((tool.strength / tool.basic_strength) * 100, 2)}%)`),
				`(after a ${Math.round(delay)}s delay)`
			);

			return makeToolClaimAction(account, tool.asset_id);
		})
		.filter(a => !!a);

	if (actions.length) {
		console.log("Claiming with Tools");

		await waitFor(delay);
		await transact({ account, privKeys: [privKey], actions });
	}
}

async function withdrawTokens(account, privKey) {
	if (!Configs.autoWithdraw) {
		return;
	}

	shuffleEndpoints();

	const { DELAY_MIN, DELAY_MAX } = process.env;
	const delayMin = parseFloat(DELAY_MIN) || 4;
	const delayMax = parseFloat(DELAY_MAX) || 10;

	logTask(`Withdrawing Tokens`);
	console.log(`Fetching account ${cyan(account)}`);
	const [accountInfo] = await fetchAccount(account);

	if (!accountInfo) {
		console.log(`${red("Error")} Account ${cyan(account)} not found`);
		return;
	}

	const { cosmic_dust, dark_matter, waves } = accountInfo;
	const balances = [cosmic_dust, dark_matter, waves].map(b => b.quantity);

	const withdrawables = balances
		.map(t => t.split(/\s+/gi))
		.map(([amount, symbol]) => ({ amount: parseFloat(amount), symbol }))
		.filter(token => {
			const threshold = Configs.withdrawThresholds.find(t => t.symbol == token.symbol);
			return threshold && token.amount >= threshold.amount;
		})
		.map(({ amount, symbol }) => {
			const max = Configs.maxWithdraw.find(t => t.symbol == symbol);
			return { amount: Math.min(amount, (max && max.amount) || Infinity), symbol };
		})
		.map(
			({ amount, symbol }) =>
				`${amount.toLocaleString("en", {
					useGrouping: false,
					minimumFractionDigits: 4,
					maximumFractionDigits: 4,
				})} ${symbol}`
		);

	if (!withdrawables.length) {
		console.log(`${yellow("Warning")}`, `Not enough tokens to auto-withdraw`, yellow(balances.join(", ")));
		return;
	}

	const delay = _.round(_.random(delayMin, delayMax, true), 2);

	console.log(`\tWithdrawing ${yellow(withdrawables.join(", "))}`, `(after a ${Math.round(delay)}s delay)`);
	const actions = withdrawables.map(quantity => makeWithdrawAction(account, quantity));

	await waitFor(delay);
	await transact({ account, privKeys: [privKey], actions });
}

async function depositTokens(account, privKey) {
	if (!Configs.autoDeposit) {
		return;
	}

	shuffleEndpoints();

	const { DELAY_MIN, DELAY_MAX } = process.env;
	const delayMin = parseFloat(DELAY_MIN) || 4;
	const delayMax = parseFloat(DELAY_MAX) || 10;

	logTask(`Depositing Tokens`);
	console.log(`Fetching account ${cyan(account)}`);
	const [accountInfo] = await fetchAccount(account);

	if (!accountInfo) {
		console.log(`${red("Error")} Account ${cyan(account)} not found`);
		return;
	}

	console.log(`Fetching balances for account ${cyan(account)}`);
	const rows = await fetchTable("spacecraftxt", "accounts", account, null, 1);
	const rawAccountBalances = rows.map(r => r.balance);
	const { cosmic_dust, dark_matter, waves } = accountInfo;
	const rawGameBalances = [cosmic_dust, dark_matter, waves].map(b => b.quantity);

	const [accountBalances, gameBalances] = [rawAccountBalances, rawGameBalances].map(bals =>
		bals.map(t => t.split(/\s+/gi)).map(([amount, symbol]) => ({ amount: parseFloat(amount), symbol }))
	);

	const meetThreshold = gameBalances.filter(token => {
		const threshold = Configs.depositThresholds.find(t => t.symbol == token.symbol);
		return threshold && token.amount < threshold.amount;
	});

	if (!meetThreshold.length) {
		console.log(`${cyan("Info")}`, `No token deposit is needed`, yellow(rawGameBalances.join(", ")));
		return;
	}

	const elligibleTokens = meetThreshold
		.map(({ symbol }) => accountBalances.find(t => t.symbol == symbol))
		.filter(b => !!b)
		.filter(({ amount }) => amount > 0);

	if (!elligibleTokens.length) {
		console.log(`${yellow("Warning")}`, `No token deposit is possible`, yellow(rawAccountBalances.join(", ")));
		return;
	}

	const depositables = elligibleTokens
		.map(({ amount, symbol }) => {
			const max = Configs.maxDeposit.find(t => t.symbol == symbol);
			return { amount: Math.min(amount, (max && max.amount) || Infinity), symbol };
		})
		.map(
			({ amount, symbol }) =>
				`${amount.toLocaleString("en", {
					useGrouping: false,
					minimumFractionDigits: 4,
					maximumFractionDigits: 4,
				})} ${symbol}`
		);

	const delay = _.round(_.random(delayMin, delayMax, true), 2);

	console.log(`\tDepositing ${yellow(depositables.join(", "))}`, `(after a ${Math.round(delay)}s delay)`);
	const actions = depositables.map(quantity => makeDepositAction(account, quantity));

	await waitFor(delay);
	await transact({ account, privKeys: [privKey], actions });
}

async function runTasks(account, privKey) {
	await depositTokens(account, privKey);
	console.log(); // just for clarity

	await recoverEnergy(account, privKey);
	console.log(); // just for clarity

	await repairTools(account, privKey);
	console.log(); // just for clarity

	await useTools(account, privKey);
	console.log(); // just for clarity

	await withdrawTokens(account, privKey);
	console.log(); // just for clarity
}

async function runAccounts(accounts) {
	for (let i = 0; i < accounts.length; i++) {
		const { account, privKey } = accounts[i];
		await runTasks(account, privKey);
	}
}

(async () => {
	console.log(`SpaceCraftX Bot initialization`);

	const accounts = Object.entries(process.env)
		.map(([k, v]) => {
			if (k.startsWith("ACCOUNT_NAME")) {
				const id = k.replace("ACCOUNT_NAME", "");
				const key = process.env[`PRIVATE_KEY${id}`];
				if (!key) {
					console.log(red(`Account ${v} does not have a PRIVATE_KEY${id} in .env`));
					return;
				}

				try {
					// checking if key is valid
					PrivateKey.fromString(key).toLegacyString();
				} catch (error) {
					console.log(red(`PRIVATE_KEY${id} is not a valid EOS key`));
					return;
				}

				return { account: v, privKey: key };
			}

			return null;
		})
		.filter(acc => !!acc);

	const { CHECK_INTERVAL } = process.env;
	const { AUTO_WITHDRAW, WITHDRAW_THRESHOLD, MAX_WITHDRAW } = process.env;
	const { AUTO_DEPOSIT, DEPOSIT_THRESHOLD, MAX_DEPOSIT } = process.env;

	const interval = parseInt(CHECK_INTERVAL) || 15;

	Configs.autoWithdraw = AUTO_WITHDRAW == 1;
	Configs.withdrawThresholds = WITHDRAW_THRESHOLD.split(",")
		.map(t => t.trim())
		.filter(t => t.length)
		.map(t => t.split(/\s+/gi))
		.map(([amount, symbol]) => ({ amount: parseFloat(amount), symbol }));

	Configs.maxWithdraw = MAX_WITHDRAW.split(",")
		.map(t => t.trim())
		.filter(t => t.length)
		.map(t => t.split(/\s+/gi))
		.map(([amount, symbol]) => ({ amount: parseFloat(amount), symbol }));

	Configs.autoDeposit = AUTO_DEPOSIT == 1;
	Configs.depositThresholds = DEPOSIT_THRESHOLD.split(",")
		.map(t => t.trim())
		.filter(t => t.length)
		.map(t => t.split(/\s+/gi))
		.map(([amount, symbol]) => ({ amount: parseFloat(amount), symbol }));

	Configs.maxDeposit = MAX_DEPOSIT.split(",")
		.map(t => t.trim())
		.filter(t => t.length)
		.map(t => t.split(/\s+/gi))
		.map(([amount, symbol]) => ({ amount: parseFloat(amount), symbol }));

	console.log(`SpaceCraftX Bot running for ${accounts.map(acc => cyan(acc.account)).join(", ")}`);
	console.log(`Running every ${interval} minutes`);
	console.log();

	runAccounts(accounts);

	setInterval(() => runAccounts(accounts), interval * 60e3);
})();
