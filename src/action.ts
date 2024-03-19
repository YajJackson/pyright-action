import * as core from "@actions/core";
import * as github from "@actions/github";
import { exec } from "@actions/exec";
import * as fs from "fs";
import { Report, parseReport } from "./schema";
import { getRelativePath } from "./helpers";

export async function run() {
    try {
        const runInfo = getRunInfo();
        const pullRequestData = await getPullRequestData(runInfo);
        const pythonFiles = await getChangedPythonFiles(
            runInfo,
            pullRequestData,
        );
        if (pythonFiles.length === 0) {
            console.log("No Python files have changed.");
            return;
        }

        await installPyright();
        const pyrightReport = await runPyright(pythonFiles);
        await commentOnPR(runInfo, pyrightReport, pullRequestData);
    } catch (error) {
        core.setFailed(`Action failed with error: ${error}`);
    }
}

const getRunInfo = () => {
    const token = core.getInput("github-token", { required: true });
    const octokit = github.getOctokit(token);
    const context = github.context;
    return { token, octokit, context };
};

async function getChangedPythonFiles(
    runInfo: ReturnType<typeof getRunInfo>,
    pullRequest: Awaited<ReturnType<typeof getPullRequestData>>,
): Promise<string[]> {
    const { octokit, context } = runInfo;

    const compareData = await octokit.rest.repos.compareCommitsWithBasehead({
        owner: context.repo.owner,
        repo: context.repo.repo,
        basehead: `${pullRequest.base.sha}...${pullRequest.head.sha}`,
    });

    return (
        compareData.data.files
            ?.filter((file) => file.filename?.endsWith(".py"))
            .map((file) => file.filename) || []
    );
}

async function getPullRequestData(runInfo: ReturnType<typeof getRunInfo>) {
    const { octokit, context } = runInfo;

    const { data: pullRequestData } = await octokit.rest.pulls.get({
        owner: context.repo.owner,
        repo: context.repo.repo,
        pull_number: context.issue.number,
    });
    return pullRequestData;
}

async function installPyright() {
    await exec("npm", ["install", "-g", "pyright"]);
}

async function runPyright(files: string[]): Promise<Report> {
    const pyrightOutput = "pyright_output.json";
    await exec(`pyright --outputjson ${files.join(" ")} > ${pyrightOutput}`);
    const output = fs.readFileSync(pyrightOutput, "utf8");
    fs.unlinkSync(pyrightOutput);
    return parseReport(output);
}

async function commentOnPR(
    runInfo: ReturnType<typeof getRunInfo>,
    report: Report,
    pullRequest: Awaited<ReturnType<typeof getPullRequestData>>,
) {
    const diagnostics = report.generalDiagnostics;
    if (diagnostics.length === 0) {
        core.info("No issues found by Pyright.");
        return;
    }

    const { octokit, context } = runInfo;

    for (const diagnostic of diagnostics) {
        if (diagnostic.range === undefined) continue;

        // Create comment on PR at specific line
        // These are considered "review comments" and are shown as annotations in the PR
        // See: https://docs.github.com/en/rest/pulls/comments?apiVersion=2022-11-28#create-a-review-comment-for-a-pull-request
        const body =
            `**Pyright Warning/Error**\n` + `Message: ${diagnostic.message}`;

        await octokit.rest.pulls.createReviewComment({
            owner: context.repo.owner,
            repo: context.repo.repo,
            pull_number: context.issue.number,
            body,
            commit_id: pullRequest.head.sha,
            path: getRelativePath(
                diagnostic.file,
                pullRequest.base.repo.full_name,
            ),
        });
    }

    // Create a comment on the PR with a summary of the issues
    const summary =
        `## Pyright Summary \n` +
        `**Errors**: ${report.summary.errorCount}\n` +
        `**Warnings**: ${report.summary.warningCount}`;
    await octokit.rest.issues.createComment({
        owner: context.repo.owner,
        repo: context.repo.repo,
        issue_number: context.issue.number,
        body: summary,
    });
}

run();
