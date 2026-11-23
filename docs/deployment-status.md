# TasteAI deployment handover — 2026-11-23

Source: botfeng/tasteai main 68f3e955df816a2094cddee539f006acee7e83b6.
Original local checkout: D:/test/tasteai (untouched).
Working checkout: E:/Codex/work/tasteai-deploy-20261123.

## Prepared
- Four fetch calls now use VITE_API_BASE_URL (origin only, without /api).
- Exact-origin CORS through CORS_ALLOWED_ORIGINS, comma separated, no trailing slash.
- render.yaml: free Python service, one worker, proxy headers disabled, mock only, paid calls false.
- Production paid calls reserve SQLite daily + lifetime attempt quota before every upstream attempt. Missing/unwritable DB refuses calls.
- Frontend build and 585 tests passed. Backend: 583 tests passed, including exact CORS preflight and persistent quota fail-closed/restart checks.

## Not deployed
No cloud resources created, no repository push, no paid calls, no secrets read/copied.
Qoder CN UI shows signed-in account and existing TasteAI workspace. This Codex session does not expose qoder_sites MCP tools. Qoder publication must use Qoder's supported UI/tools; do not substitute ChatGPT Sites.

## Remaining steps
1. User authorized free Render deployment, repository connection and public Qoder Sites Mock demonstration. New account terms, expanded permissions and any payment still require user action.
2. Deploy render.yaml from a reviewed deployment branch with mock enabled. Obtain actual HTTPS service URL.
3. Build frontend with VITE_API_BASE_URL set to that URL; deploy dist through Qoder Sites. Set backend CORS to exact returned frontend origin.
4. Verify health, preflight, generation, swap, images and mobile layout over public HTTPS.
5. Before enabling real AI, choose durable budget storage. Render Free filesystem is ephemeral; SQLite on that filesystem cannot protect quota across redeploys. Keep mock on Free until durable storage is arranged. No paid disk or other service may be purchased without approval.
6. Configure DeepSeek key only through backend secret input after authorization. Set production mode, explicit paid opt-in, token limit, zero repairs, daily and lifetime quota; verify one authorized real request. Attempt limits are not an exact currency cap; agree a monetary budget after checking current provider prices.
7. Emergency stop: set LLM_MODE=disabled and LLM_ALLOW_PAID_CALLS=false and restart service. Rollback by previous platform deployment; preserve quota DB.

Render Free sleeps and has resource/usage restrictions: https://render.com/docs/free
Qoder CN Free supports static deployment: https://docs.qoder.cn/qoder/sites

## Verification limits
Local build is currently configured without a production URL; it is not a publishable production release. Backend tests use mocks, not live paid provider calls. No public URL or competition submission exists yet.
