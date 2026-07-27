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
- `lambda:UpdateFunctionConfiguration` (required to keep the Node.js 24 runtime in sync)
- `lambda:GetFunction` (optional but useful)

### Option 2: Recommended — GitHub OIDC (No long-lived keys)

This is the modern and more secure way. We have switched the workflow to use OIDC.

#### Step-by-step OIDC Setup

**1. Create the OIDC Identity Provider in AWS (one time per account)**

If you haven't done this before for GitHub Actions:

- Go to IAM → Identity providers → Add provider
- Provider type: **OpenID Connect**
- Provider URL: `https://token.actions.githubusercontent.com`
- Audience: `sts.amazonaws.com`
- Click **Add provider**

**2. Create an IAM Role for GitHub Actions**

- IAM → Roles → Create role
- Trusted entity type: **Web identity**
- Identity provider: `token.actions.githubusercontent.com`
- Audience: `sts.amazonaws.com`
- Click **Next**

**3. Add trust policy conditions (important!)**

After creating the role, edit the Trust policy and replace it with this:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::834917996497:oidc-provider/token.actions.githubusercontent.com"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com"
        },
        "StringLike": {
          "token.actions.githubusercontent.com:sub": "repo:jeromevidaao/auto-reply-sqs-harness:*"
        }
      }
    }
  ]
}
```

**4. Attach permissions to the role**

Attach a policy with at minimum:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "lambda:UpdateFunctionCode",
        "lambda:UpdateFunctionConfiguration",
        "lambda:GetFunction"
      ],
      "Resource": "arn:aws:lambda:us-east-1:834917996497:function:guest-messaging-agent-harness"
    }
  ]
}
```

**5. Create the GitHub Secret**

- Go to your GitHub repo → **Settings → Secrets and variables → Actions**
- Create a new secret called: `AWS_ROLE_ARN`
- Value: `arn:aws:iam::834917996497:role/github-actions-auto-reply-sqs-harness-deploy`

(The role has been pre-created for you with the correct trust policy and minimal permissions.)

**6. Update the workflow (already done)**

The `deploy.yml` now uses:

```yaml
- name: Configure AWS credentials (via OIDC)
  uses: aws-actions/configure-aws-credentials@v4
  with:
    role-to-assume: ${{ secrets.AWS_ROLE_ARN }}
    aws-region: us-east-1
```

---

**Current status**: The workflow is ready for OIDC. Once you complete the steps above and add the `AWS_ROLE_ARN` secret, pushes to `main` will authenticate to AWS without any long-lived keys.

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
- **Runtime**: `nodejs24.x` (updated automatically on deploy)

## Future Improvements (when ready)

- Add deployment to a staging Lambda first
- Use GitHub Environments + required reviewers for production
- Add automatic rollback on failed health checks
- Use OIDC instead of IAM keys

---

**Current status**: As of the latest commit, pushing to `main` will trigger a full deployment after CI passes.

## Host contacts (SSM only)

Personal phone numbers, owner email, WiFi password, backup door code, and lockbox codes are **not** in this repository.

| Parameter | Type | Purpose |
|-----------|------|---------|
| `/host/contacts-json` | SecureString | JSON: host phones, PM phones, WiFi, `backupDoorCode`, `apt2StreetLockboxCode`, `apt3LockboxCode`, urgent-access E.164 list |

Lambda role needs `ssm:GetParameter` on `arn:...:parameter/host/*`.
Prompt markdown uses placeholders like `{{HOST_JEROME_PHONE}}` substituted at runtime.
