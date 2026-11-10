# The Shape of Telem

Telem is made up of a set of skills and helper packages. While the vast majority is platform-agnostic, each platform must have its own set of skills and tools to specialize guidance.
All of Telem's skills, tools, etc. live in their own repository, not the target repository of the code under test. Adapt this when building in a mono-repo / singleton-repo case.

# Skills (Harness Plugin)

The skills described here are used for building tests from source code. They do not assume the code is correct - they build tests that represent the current reality of the code.

**Note:** Skills here are prefixed `/telem-{platform}` (e.g. `/telem-node`, `/telem-python`). Build one for each platform you need to support.

## `/telem-{platform}:backfill`

The first step in using Telem is backfilling all the Telem-style tests that don't exist yet. Without full use-case coverage, we can't rely on the Red-Green-Refactor-Whitebox process to provide good outcomes. The set of skills orchestrated by `backfill` provides agents and humans with all the tools they need to act.

To construct it, read [`/backfill`](skills/backfill.md).

## `/telem-{platform}:graduate`

Once backfilling is done, the repo **graduates** and is set up for contributions to follow the Red-Green-Refactor-Whitebox process.

To construct it, read [`/backfill`](skills/backfill.md).

## `/telem-{platform}:sync`

We shouldn't blindly rely on the post-graduation process to keep the tests comprehensive and fresh. This skill is set up to run on a regular cadence, build missing tests and keep the repo up to par with all upgrades to the methodology.

To construct it, read [`/sync`](skills/sync.md).

## `/telem-{platform}:contribute-*`

These skills are loaded as part of the red-green-refactor-whitebox loop, as a way of providing context, tooling and methods. You can see them referred in the [Red-Green-Refactor-Whitebox example guidance](./red-green-refactor-whitebox.md).

## The Rest

There are multiple other skills that can be created for convenience, such as one for an agent to read code review comments and check whether they should be rejected on methodological grounds (as it's the author of the tests). They'll be detailed later in this guide.

**Note:** Advice on how to build effective skills is still a moving target, advancing as models and coding harnesses advance. Research relevant guides on effective skill-building and take notes.

## Refactoring Skills

There are large parts of the skills that repeat themselves. For instance, knowledge of what a good test looks like is required by all test-building skills. Extract those into Methodology Cores and invoke them from every skill that needs them. 

# Packages

## Linters

There are three types of linters that are used by Telem:

### 1. Platform-specific

Each platform has its own linters, like eslint for Node and flake8 for Python. Whatever you use in your environment is good enough, as long as it's pluggable. Telem includes a set of rules that keep statically-discoverable issues easy and quick to discover and fix.

### 2. Gherkin

Gherkin syntax is its own syntax with its own linter, like `gplint`. Telem introduces an opinionated set of rules that is used to keep the syntax consistent and readable.

### 3. Judgement-based

Judgment-based lint rules that can't be expressed as regex or AST checks must use some other means. This is where `llm-lint` comes in. It sends one or more source files with a system prompt to another agent, usually a fast and cheap one, asking it to flag issues. When that agent comes back with a set of violations, the main agent can agree or disagree with the assessment. The underlying requirement is not optional, and judgment is only meant to applied to whether the rule was violated.

## Other Utilities

Each platform would have its own package with utilities used to build and run the tests, like `run-flag-permutations` (aka the permutation runner) which runs all the tests with all feature flag permutations, in parallel to each other. These must provide a command-line interface so they're invocable.

## Specifications

For the tools you will have to build yourself, please see the [Tool Specs](./tools) list, where you can find a specification for each tool.
