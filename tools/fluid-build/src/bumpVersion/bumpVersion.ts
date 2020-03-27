/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */


import * as path from "path";
import { commonOptions, commonOptionString, parseOption } from "../common/commonOptions";
import { Timer } from "../common/timer";
import { getResolvedFluidRoot } from "../common/fluidUtils";
import { FluidRepoBase } from "../common/fluidRepoBase";
import { MonoRepo, MonoRepoKind } from "../common/monoRepo";
import * as semver from "semver";
import { Package } from "../common/npmPackage";
import { execWithErrorAsync } from "../common/utils";
import { logVerbose } from "../common/logging";

function printUsage() {
    console.log(
        `
Usage: fluid-bump-version <options>
Options:
${commonOptionString}
`);
}

function versionCheck() {
    const pkg = require(path.join(__dirname, "..", "..", "package.json"));
    const builtVersion = "0.0.5";
    if (pkg.version > builtVersion) {
        console.warn(`WARNING: fluid-bump-version is out of date, please rebuild (built: ${builtVersion}, package: ${pkg.version})\n`);
    }
}

function parseOptions(argv: string[]) {
    let error = false;
    for (let i = 2; i < process.argv.length; i++) {
        const argParsed = parseOption(argv, i);
        if (argParsed < 0) {
            error = true;
            break;
        }
        if (argParsed > 0) {
            i += argParsed - 1;
            continue;
        }

        const arg = process.argv[i];

        if (arg === "-?" || arg === "--help") {
            printUsage();
            process.exit(0);
        }

        console.error(`ERROR: Invalid arguments ${arg}`);
        error = true;
        break;
    }

    if (error) {
        printUsage();
        process.exit(-1);
    }
}

parseOptions(process.argv);

function saveVersion(versions: { [key: string]: string }, name: string, version: string, monoRepo?: MonoRepo) {
    if (monoRepo === undefined) {
        versions[name] = version;
    } else if (name.startsWith("@fluid-example/version-test")) {
        // Ignore example packages
        return;
    } else if (versions[MonoRepoKind[monoRepo.kind]]) {
        if (versions[MonoRepoKind[monoRepo.kind]] !== version) {
            throw new Error(`Inconsistent version within Monorepo ${name} ${version}`);
        }
    } else {
        versions[MonoRepoKind[monoRepo.kind]] = version;
    }
}

function collectVersions(repo: FluidRepoBase, generatorPackage: Package, templatePackage: Package) {
    const versions: { [key: string]: string } = {};

    repo.packages.packages.forEach(pkg => {
        saveVersion(versions, pkg.name, pkg.version, pkg.monoRepo);
    });

    saveVersion(versions, generatorPackage.name, generatorPackage.version);
    saveVersion(versions, templatePackage.name, templatePackage.version);
    return versions;
}

async function bumpGeneratorFluid(buildPackages: Map<string, Package>, generatorPackage: Package, templatePackage: Package, versionBump: string) {
    console.log("Bumping generator version");

    for (const { name, dev } of templatePackage.combinedDependencies) {
        const pkg = buildPackages.get(name);
        if (pkg) {
            if (dev) {
                templatePackage.packageJson.devDependencies[name] = `^${pkg.version}`;
            } else {
                templatePackage.packageJson.dependencies[name] = `^${pkg.version}`;
            }
        }
    }
    await templatePackage.savePackageJson();
    await execWithErrorAsync(`npm version ${versionBump}`, { cwd: templatePackage.directory }, templatePackage.directory, false);
    await execWithErrorAsync(`npm version ${versionBump}`, { cwd: generatorPackage.directory }, generatorPackage.directory, false);
}

async function main() {
    const timer = new Timer(commonOptions.timer);

    versionCheck();

    const resolvedRoot = await getResolvedFluidRoot();

    // Determine the line of bump
    const result = await execWithErrorAsync("git rev-parse --abbrev-ref HEAD", { cwd: resolvedRoot }, resolvedRoot, false);
    if (result.error) {
        process.exit(1);
    }

    const branchName = result.stdout.split("\n")[0];
    if (branchName !== "master" && !branchName.startsWith("release/")) {
        console.error(`ERROR: Unrecognized branch '${branchName}'`);
        process.exit(2)
    }

    const versionBump = branchName === "master" ? "minor" : "patch";
    console.log(`Bumping ${versionBump} version`);

    // Load the package
    const repo = new FluidRepoBase(resolvedRoot);
    timer.time("Package scan completed");

    const packageNeedBump = new Set<Package>();
    let serverNeedBump = false;
    const buildPackages = repo.createPackageMap();

    const depVersions: { [key: string]: string } = {};
    const checkPackageNeedBump = (pkg: Package) => {
        for (const { name: dep, version } of pkg.combinedDependencies) {
            const depBuildPackage = buildPackages.get(dep);
            if (depBuildPackage) {
                let depVersion = depBuildPackage.version;
                if (semver.satisfies(depVersion, version)) {
                    if (depBuildPackage.monoRepo === undefined) {
                        if (!packageNeedBump.has(depBuildPackage)) {
                            packageNeedBump.add(depBuildPackage);
                            logVerbose(`${depBuildPackage.nameColored}: Add from ${pkg.nameColored} ${version}`)
                            checkPackageNeedBump(depBuildPackage);
                        }
                    } else if (depBuildPackage.monoRepo.kind === MonoRepoKind.Server) {
                        serverNeedBump = true;
                    }
                } else {
                    depVersion = semver.minVersion(version)!.version;
                }
                saveVersion(depVersions, dep, depVersion, depBuildPackage.monoRepo);
            }
        }
    };

    const checkMonoRepoNeedBump = (checkRepo: MonoRepoKind) => {
        repo.packages.packages.forEach(pkg => {
            if (pkg.monoRepo?.kind !== checkRepo) {
                return;
            }
            checkPackageNeedBump(pkg);
        });
    };

    checkMonoRepoNeedBump(MonoRepoKind.Client);

    if (serverNeedBump) {
        checkMonoRepoNeedBump(MonoRepoKind.Server);
    }

    const generatorDir = path.join(resolvedRoot, "tools", "generator-fluid");
    const generatorPackage = new Package(path.join(generatorDir, "package.json"));
    const templatePackage = new Package(path.join(generatorDir, "app", "templates", "package.json"));
    saveVersion(depVersions, generatorPackage.name, generatorPackage.version);
    saveVersion(depVersions, templatePackage.name, templatePackage.version);

    const oldVersions = collectVersions(repo, generatorPackage, templatePackage);
    console.log("Release Versions:");
    for (const name in oldVersions) {
        console.log(`${name.padStart(40)}: ${depVersions[name].padStart(10)} ${!oldVersions || oldVersions[name] !== depVersions[name] ? "(old)" : "(new)"}`);
    }
    console.log();

    const bumpMonoRepo = async (monoRepo: MonoRepo) => {
        const repoPath = monoRepo.repoPath;
        return await execWithErrorAsync(`npx lerna version ${versionBump} --no-push --no-git-tag-version -y && npm run build:genver`, {
            cwd: repoPath,
        }, repoPath, false);
    }

    console.log("Bumping client version");
    await bumpMonoRepo(repo.clientMonoRepo)

    if (serverNeedBump) {
        console.log("Bumping server version");
        await bumpMonoRepo(repo.serverMonoRepo);
    }

    for (const pkg of packageNeedBump) {
        console.log(`Bumping ${pkg.name}`);
        let cmd = `npm version ${versionBump}`;
        if (pkg.getScript("build:genver")) {
            cmd += " && npm run build:genver";
        }
        await execWithErrorAsync(cmd, { cwd: pkg.directory }, pkg.directory, false);
    }

    // Package json has changed. Reload.
    repo.reload();

    await bumpGeneratorFluid(buildPackages, generatorPackage, templatePackage, versionBump);

    // Generate has changed. Reload.
    generatorPackage.reload();
    templatePackage.reload();

    console.log("\nRepo Versions:");
    const newVersions = collectVersions(repo, generatorPackage, templatePackage);
    for (const name in newVersions) {
        if (!oldVersions || oldVersions[name] !== newVersions[name]) {
            console.log(`${name.padStart(40)}: ${oldVersions[name].padStart(10)} -> ${newVersions[name].padEnd(10)}`);
        } else {
            console.log(`${name.padStart(40)}: ${newVersions[name].padStart(10)} (unchanged)`);
        }
    }
}

main().catch(e => {
    console.error("ERROR: unexpected error", JSON.stringify(e, undefined, 2))
    if (e.stack) {
        console.error(`Stack:\n${e.stack}`);
    }
});