# Contributing

## Creating an issue

If you have found a bug, want to request an enhancement or simply ask
a question, feel free to open an
[issue](https://github.com/leplusorg/catchme/issues/new/choose).

For security-related issues, please see our [security policy](/SECURITY.md).

## Submitting a pull request

If you want to contribute code, documentation etc. you can open a pull
request. We then kindly ask that:

- before working or submitting a large pull request, please open an
  issue to discuss what you have in mind and check that there is not
  an existing solution or a different approach.
- all code changes must be tested manually and automated tests should
  be included when possible.
- all necessary documentation should be included as well.
- commit messages must follow the [conventional commits specification](https://www.conventionalcommits.org).
  See commit history for examples.
- commits on a single pull request must be squashed together to keep
  make reviews easier.
- commits must be signed (this is supported by most Git clients as
  well as the GitHub web UI, see link below).

## Architecture decisions

If something in the codebase looks like the wrong choice, check
[ADR.md](/ADR.md) first — it usually records why, and what the alternative
cost. The record is append-only: to revisit a decision, add a new entry that
supersedes the earlier one rather than editing it.

Changes that alter an architectural decision should add a record in the same
pull request.

## Resources

- [Managing commit signature verification](https://docs.github.com/en/authentication/managing-commit-signature-verification)
- [Using Pull Requests](https://docs.github.com/en/github/collaborating-with-pull-requests/proposing-changes-to-your-work-with-pull-requests/about-pull-requests)
