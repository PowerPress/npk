'use strict';

const fs = require("fs");
const readline = require("readline");

const { exec } = require("child_process");
const { Sonnet } = require("@c6fc/sonnetry");
const { Jsonnet } = require("@hanazuki/node-jsonnet");

const sonnetry = new Sonnet({
	renderPath: './render-npk',
	cleanBeforeRender: true
});

async function generate() {

	console.log("***********************************************************");
	console.log(" Hello friend! Thanks for using NPK!");
	console.log("");
	console.log(" Need help, want to contribute, or want to brag about a win?");
	console.log(" Join us on Discord! [ https://discord.gg/k5PQnqSNDF ]");
	console.log("");
	console.log(" Sincerely, @c6fc");
	console.log("***********************************************************");
	console.log("");

	let settings;

	try {
		settings = JSON.parse(fs.readFileSync('./npk-settings.json'));
	} catch (e) {
		console.log(e);
		console.log("\n[!] Unable to open npk-settings.json. Does it exist?");
		return false;
	}

	if (!!settings.awsProfile) {
		process.env.AWS_PROFILE = settings.awsProfile
	}

	await sonnetry.auth();
	const aws = sonnetry.aws;

	const validatedSettings = {};

	// Check for invalid settings
	const allowedSettings = [
		'campaign_data_ttl',
		'campaign_max_price',
		'georestrictions',
		'route53Zone',
		'awsProfile',
		'criticalEventsSMS',
		'adminEmail',
		'sAMLMetadataFile',
		'sAMLMetadataUrl',
		'primaryRegion'
	];

	const badSettings = Object.keys(settings)
		.filter(e => allowedSettings.indexOf(e) < 0)
		.map(e => console.log(`[!] Invalid setting key [${e}] in npk-settings.json`));

	if (badSettings.length > 0) {
		console.log('[!] Fix your settings, then try again.');
		return false;
	}

	// Determine the route53 zone information.
	if (!!settings.route53Zone) {
		const route53 = new aws.Route53();
		let zone;

		try {
			zone = await route53.getHostedZone({
				Id: settings.route53Zone
			}).promise();

			validatedSettings.dnsBaseName = zone.HostedZone.Name.slice(0, -1)

			console.log("[+] Validated route53Zone");

		} catch(e) {
			console.log(`[!] Unable to retrieve hosted zone. ${e}`);
			return false;
		}
	}

	// Generate region list. AZ's are done later to only capture those with appropriate quotas.
	const ec2 = new aws.EC2({ region: "us-east-1" });
	let regions;

	try {
		regions = await ec2.describeRegions().promise()

		regions = regions.Regions
			.filter(r => ["opt-in-not-required", "opted-in"].indexOf(r.OptInStatus) > -1)
			.map(r => r.RegionName);

	} catch (e) {
		console.log(`[!] Unable to retrieve region list. ${e}`);
		return false;
	}

	validatedSettings.providerRegions = regions;

	console.log("[+] Retrieved all active regions");

	// Check quotas for all regions.
	const families = JSON.parse(fs.readFileSync('./jsonnet/gpu_instance_families.json'));

	const quotaCodes = Object.keys(families).reduce((codes, family) => {
		const code = families[family].quotaCode;

		if (codes.indexOf(code) == -1) {
			codes.push(code);
		}

		return codes;
	}, []);

	let maxQuota = 0;
	const regionQuotas = {};
	const quotaPromises = regions.reduce((quotas, region) => {
		const sq = new aws.ServiceQuotas({ region });

		quotas.push(sq.listServiceQuotas({
			ServiceCode: 'ec2'
		}).promise().then((data) => {

			data.Quotas
				.filter(q => quotaCodes.indexOf(q.QuotaCode) > -1 && q.Value > 0)
				.map(q => {
					regionQuotas[region] ??= {};

					regionQuotas[region][q.QuotaCode] = q.Value;
					maxQuota = (q.Value > maxQuota) ? q.Value : maxQuota;
				});
		}));

		return quotas;
	}, []);

	await Promise.all(quotaPromises);

	if (maxQuota == 0) {
		console.log("[!] You are permitted zero GPU spot instances across all types and regions.");
		console.log("You cannot proceed without increasing your limits.");
		console.log("-> A limit of at least 4 is required for minimal capacity.");
		console.log("-> A limit of 40 is required to use the largest instances.");

		return false;
	}

	validatedSettings.quotas = regionQuotas;
	
	console.log("[+] Retrieved quotas.");

	// Retrieve availability zones for regions with appropriate quotas.
	const azs = {};
	const azPromises = Object.keys(regionQuotas).reduce((promises, region) => {
		const ec2 = new aws.EC2({ region });

		azs[region] = [];

		promises.push(ec2.describeAvailabilityZones().promise().then((data) => {
			data.AvailabilityZones
				.filter(a => a.State == "available")
				.map(a => azs[region].push(a.ZoneName));
		}));

		return promises;
	}, []);

	await Promise.all(azPromises);

	validatedSettings.regions = azs;

	console.log("[+] Retrieved availability zones.");

	const iam = new aws.IAM();

	validatedSettings.spotslr_exists = true;

	try {
		await iam.getRole({
			RoleName: "AWSServiceRoleForEC2Spot"
		}).promise();
	} catch (e) {
		console.log(`[*] EC2 spot SLR is not present.`);
		validatedSettings.spotslr_exists = false;
	}

	console.log("\n[*] All prerequisites finished. Generating infrastructure configurations.");

	sonnetry.export('validatedSettings', validatedSettings);

	try {
		await sonnetry.render('terraform.jsonnet');
	} catch (e) {
		console.trace(e);
		console.log(`\n[!] Failed to generate NPK configurations.`);
		return false;
	}

	sonnetry.write();

	console.log(`[+] Configurations updated successfully. Preparing to deploy.`);

	try {
		sonnetry.apply(true, true);
	} catch (e) {
		console.trace(e);
		console.log('\n[!] Failed to apply configuration.')
		return false;
	}

	console.log("[+] NPK successfully deployed. Happy hunting.");

	return true;
}

function showHelpBanner() {
	console.log("[!] Deployment failed. If you're having trouble, hop in Discord for help.");
	console.log("--> Porchetta Industries Discord: https://discord.gg/k5PQnqSNDF");
	console.log("");
	process.exit(1);
}

(async () => {
	const success = await generate();
	if (!success) showHelpBanner();
})();