import * as path from "node:path";

import * as core from "@actions/core";
import * as httpClient from "@actions/http-client";
import * as tc from "@actions/tool-cache";
import SemVer from "semver/classes/semver";
import { parse, quote } from "shell-quote";
import { type Diagnostic, isEmptyRange } from "./schema";

import { version as actionVersion } from "../package.json";
import {
    type NpmRegistryResponse,
    parseNpmRegistryResponse,
    parsePylanceBuildMetadata,
} from "./schema";

export function getActionVersion() {
    return actionVersion;
}

export interface NodeInfo {
    version: string;
    execPath: string;
}

export function getNodeInfo(process: NodeInfo): NodeInfo {
    return {
        version: process.version,
        execPath: process.execPath,
    };
}

export interface Args {
    workingDirectory: string;
    annotate: ReadonlySet<"error" | "warning">;
    pyrightVersion: string;
    args: readonly string[];
}

// https://github.com/microsoft/pyright/blob/c8a16aa148afea403d985a80bd87998b06135c93/packages/pyright-internal/src/pyright.ts#LL188C35-L188C84
// But also with --verifytypes, which supports JSON but this action doesn't do anything with it.
const flagsWithoutCommentingSupport = new Set([
    "--verifytypes",
    "--stats",
    "--verbose",
    "--createstub",
    "--dependencies",
]);

// TODO: allow non-dashed forms to be passed as inputs. A long time ago, I
// went with dashed names as pyright was not fully consistent, and dashes were
// consistent with other GitHub actions. However, pyright has now gone the
// other way and settled on no dashes in flag names. So, it's probably clearer
// if this action supports the names without dashes.

export async function getArgs(): Promise<Args> {
    const pyrightInfo = await getPyrightInfo();
    const pyrightPath = await downloadPyright(pyrightInfo);

    const pyrightVersion = new SemVer(pyrightInfo.version);
    // https://github.com/microsoft/pyright/commit/ba18f421d1b57c433156cbc6934e0893abc130db
    const useDashedFlags = pyrightVersion.compare("1.1.309") === -1;

    const args = [path.join(pyrightPath, "package", "index.js")];

    // pyright-action options
    const workingDirectory = core.getInput("working-directory");

    // pyright flags
    const createStub = core.getInput("create-stub");
    if (createStub) {
        args.push("--createstub", createStub);
    }

    const dependencies = core.getInput("dependencies");
    if (dependencies) {
        args.push("--dependencies", dependencies);
    }

    const ignoreExternal = core.getInput("ignore-external");
    if (ignoreExternal) {
        args.push("--ignoreexternal");
    }

    const level = core.getInput("level");
    if (level) {
        args.push("--level", level);
    }

    const project = core.getInput("project");
    if (project) {
        args.push("--project", project);
    }

    const pythonPlatform = core.getInput("python-platform");
    if (pythonPlatform) {
        args.push("--pythonplatform", pythonPlatform);
    }

    const pythonPath = core.getInput("python-path");
    if (pythonPath) {
        args.push("--pythonpath", pythonPath);
    }

    const pythonVersion = core.getInput("python-version");
    if (pythonVersion) {
        args.push("--pythonversion", pythonVersion);
    }

    const skipUnannotated = getBooleanInput("skip-unannotated", false);
    if (skipUnannotated) {
        args.push("--skipunannotated");
    }

    const stats = getBooleanInput("stats", false);
    if (stats) {
        args.push("--stats");
    }

    const typeshedPath = core.getInput("typeshed-path");
    if (typeshedPath) {
        args.push(
            useDashedFlags ? "--typeshed-path" : "--typeshedpath",
            typeshedPath,
        );
    }

    const venvPath = core.getInput("venv-path");
    if (venvPath) {
        args.push(useDashedFlags ? "--venv-path" : "--venvpath", venvPath);
    }

    const verbose = getBooleanInput("verbose", false);
    if (verbose) {
        args.push("--lib");
    }

    const verifyTypes = core.getInput("verify-types");
    if (verifyTypes) {
        args.push("--verifytypes", verifyTypes);
    }

    const warnings = getBooleanInput("warnings", false);
    if (warnings) {
        args.push("--warnings");
    }

    // Deprecated flags
    const lib = getBooleanInput("lib", false);
    if (lib) {
        args.push("--lib");
    }

    const extraArgs = core.getInput("extra-args");
    if (extraArgs) {
        for (const arg of parse(extraArgs)) {
            if (typeof arg !== "string") {
                // eslint-disable-next-line unicorn/prefer-type-error
                throw new Error(`malformed extra-args: ${extraArgs}`);
            }
            args.push(arg);
        }
    }

    let annotateInput = core.getInput("annotate").trim() || "all";
    if (isAnnotateNone(annotateInput)) {
        annotateInput = "";
    } else if (isAnnotateAll(annotateInput)) {
        annotateInput = "errors, warnings";
    }

    const split = annotateInput ? annotateInput.split(",") : [];
    const annotate = new Set<"error" | "warning">();

    for (let value of split) {
        value = value.trim();
        switch (value) {
            case "errors":
                annotate.add("error");
                break;
            case "warnings":
                annotate.add("warning");
                break;
            default:
                if (isAnnotateAll(value) || isAnnotateNone(value)) {
                    throw new Error(
                        `invalid value ${JSON.stringify(
                            value,
                        )} in comma-separated annotate`,
                    );
                }
                throw new Error(
                    `invalid value ${JSON.stringify(value)} for annotate`,
                );
        }
    }

    const noComments =
        getBooleanInput("no-comments", false) ||
        args.some((arg) => flagsWithoutCommentingSupport.has(arg));

    if (noComments) {
        annotate.clear();
    }

    return {
        workingDirectory,
        annotate,
        pyrightVersion: pyrightInfo.version,
        args,
    };
}

function isAnnotateNone(name: string): boolean {
    return name === "none" || name.toUpperCase() === "FALSE";
}

function isAnnotateAll(name: string): boolean {
    return name === "all" || name.toUpperCase() === "TRUE";
}

function getBooleanInput(name: string, defaultValue: boolean): boolean {
    const input = core.getInput(name);
    if (!input) {
        return defaultValue;
    }
    return input.toUpperCase() === "TRUE";
}

const pyrightToolName = "pyright";

async function downloadPyright(info: NpmRegistryResponse): Promise<string> {
    // Note: this only works because the pyright package doesn't have any
    // dependencies. If this ever changes, we'll have to actually install it.
    // eslint-disable-next-line unicorn/no-array-callback-reference, unicorn/no-array-method-this-argument
    const found = tc.find(pyrightToolName, info.version);
    if (found) {
        return found;
    }

    const tarballPath = await tc.downloadTool(info.dist.tarball);
    const extractedPath = await tc.extractTar(tarballPath);
    return await tc.cacheDir(extractedPath, pyrightToolName, info.version);
}

async function getPyrightInfo(): Promise<NpmRegistryResponse> {
    const version = await getPyrightVersion();
    const client = new httpClient.HttpClient();
    const url = `https://registry.npmjs.org/pyright/${version}`;
    const resp = await client.get(url);
    const body = await resp.readBody();
    if (resp.message.statusCode !== httpClient.HttpCodes.OK) {
        throw new Error(
            `Failed to download metadata for pyright ${version} from ${url} -- ${body}`,
        );
    }
    return parseNpmRegistryResponse(JSON.parse(body));
}

async function getPyrightVersion(): Promise<string> {
    const versionSpec = core.getInput("version");
    if (versionSpec) {
        return new SemVer(versionSpec).format();
    }

    const pylanceVersion = core.getInput("pylance-version");
    if (pylanceVersion) {
        if (
            pylanceVersion !== "latest-release" &&
            pylanceVersion !== "latest-prerelease"
        ) {
            new SemVer(pylanceVersion); // validate version string
        }

        return await getPylancePyrightVersion(pylanceVersion);
    }

    return "latest";
}

async function getPylancePyrightVersion(
    pylanceVersion: string,
): Promise<string> {
    const client = new httpClient.HttpClient();
    const url = `https://raw.githubusercontent.com/microsoft/pylance-release/main/releases/${pylanceVersion}.json`;
    const resp = await client.get(url);
    const body = await resp.readBody();
    if (resp.message.statusCode !== httpClient.HttpCodes.OK) {
        throw new Error(
            `Failed to download release metadata for Pylance ${pylanceVersion} from ${url} -- ${body}`,
        );
    }

    const buildMetadata = parsePylanceBuildMetadata(JSON.parse(body));
    const pyrightVersion = buildMetadata.pyrightVersion;

    core.info(`Pylance ${pylanceVersion} uses pyright ${pyrightVersion}`);

    return pyrightVersion;
}

export function pluralize(n: number, singular: string, plural: string) {
    return `${n} ${n === 1 ? singular : plural}`;
}

// Copied from pyright, with modifications.
export function diagnosticToString(
    diag: Diagnostic,
    forCommand: boolean,
): string {
    let message = "";

    if (!forCommand) {
        if (diag.file) {
            message += `${diag.file}:`;
        }
        if (diag.range && !isEmptyRange(diag.range)) {
            message += `${diag.range.start.line + 1}:${
                diag.range.start.character + 1
            } -`;
        }
        message += ` ${diag.severity}: `;
    }

    message += diag.message;

    if (diag.rule) {
        message += ` (${diag.rule})`;
    }

    return message;
}

export function printInfo(
    pyrightVersion: string,
    node: NodeInfo,
    cwd: string,
    args: readonly string[],
) {
    core.info(
        `pyright ${pyrightVersion}, node ${
            node.version
        }, pyright-action ${getActionVersion()}`,
    );
    core.info(`Working directory: ${cwd}`);
    core.info(`Running: ${node.execPath} ${quote(args)}`);
}

export const getRelativePath = (fullPath: string, repo: string) => {
    const endOfRepoNameIndex = fullPath.indexOf(repo) + repo.length;
    return fullPath.slice(endOfRepoNameIndex + 1);
};
