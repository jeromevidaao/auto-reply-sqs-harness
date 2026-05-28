# Deployment Guide (CI/CD)

This project uses GitHub Actions for continuous deployment.

## How Deployment Works

- **Every push to `main`** automatically deploys the latest code to the AWS Lambda function `guest-messaging-agent-harness`.
- **Pull Requests** only run CI (tests + evaluation suite). Nothing is deployed.
- You can still trigger a manual deployment via the "Actions" tab → "Deploy to AWS Lambda" → "Run workflow".

### Safety Controls

For this model to be safe, **Branch Protection must be enabled** on the `main` branch (see setup below). This ensures that code cannot be merged to `main` unless all CI checks pass.

## Required GitHub Secrets

Go to your repository → **Settings → Secrets and variables → Actions**.

### Option 1: Long-lived AWS Access Keys (Quick start)

Add these two secrets:

- `AWS_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY`

These keys need at minimum the following permissions:
- `lambda:UpdateFunctionCode`
- `lambda:GetFunction` (optional but useful)

### Option 2: Recommended — GitHub OIDC (No long-lived keys)

This is the modern and more secure way.

1. In AWS IAM, create an Identity Provider for GitHub OIDC.
2. Create an IAM Role that trusts GitHub's OIDC provider with conditions for your repository.
3. Grant the role permission to update the Lambda function.

Then in the workflow, replace the credentials step with:

```yaml
- name: Configure AWS credentials
  uses: aws-actions/configure-aws-credentials@v4
  with:
    role-to-assume: arn:aws:iam::YOUR_ACCOUNT_ID:role/YOUR_GITHUB_OIDC_ROLE
    aws-region: us-east-1
```

We can help you set this up if you want (just say the word).

## Enabling Branch Protection (Required)

1. Go to your repository on GitHub.
2. **Settings → Branches**.
3. Click **Add branch protection rule** for the `main` branch.
4. Check these important settings:
   - ✅ Require status checks to pass before merging
   - Add the following required checks:
     - `Run Tests`
     - `Run Evaluation Suite`
   - (Optional but recommended) Require branches to be up to date before merging
   - (Optional) Require pull request reviews (at least 1)

This guarantees that broken code cannot reach `main` and therefore cannot be deployed.

## Manual Deployment

If you ever need to deploy without pushing code (rare):

1. Go to the **Actions** tab.
2. Select the workflow **"Deploy to AWS Lambda"**.
3. Click **"Run workflow"**.
4. Choose the branch (usually `main`) and click **Run workflow**.

## Current Lambda Function

- **Function name**: `guest-messaging-agent-harness`
- **Region**: `us-east-1`
- **Handler**: `lambda/handler.handler`

## Future Improvements (when ready)

- Add deployment to a staging Lambda first
- Use GitHub Environments + required reviewers for production
- Add automatic rollback on failed health checks
- Use OIDC instead of IAM keys

---

**Current status**: As of the latest commit, pushing to `main` will trigger a full deployment after CI passes.