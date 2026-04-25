# GitHub Actions

This directory holds CI configuration for the public Avalon Game Platform repo.

## Workflows

| File                  | Purpose                                    | Triggers              |
|-----------------------|--------------------------------------------|-----------------------|
| `workflows/ci.yml`    | Build + type-check + lint + test + audit  | Push to main, all PRs |

## Pull request template

`pull_request_template.md` is auto-loaded when a contributor opens a PR.

## Deployments

This OSS repo intentionally does **not** include deploy-to-production
workflows. Production deployment of the original instance is handled in a
separate, private operations repo and is not required to develop or test
locally.

If you fork this project and want to set up your own CI/CD pipeline:

1. Add your secrets via the GitHub repo settings (`Settings > Secrets`)
2. Add a custom workflow file (e.g. `workflows/deploy-mine.yml`)
3. The CI workflow defined here uses test placeholders for Vite env vars
   so it does not require any secrets to pass
