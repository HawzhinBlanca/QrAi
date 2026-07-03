# ML Smoke API Key Plan

1. Add a shared local-default `mlApiKey` constant to both ML smoke clients.
2. Send `x-ml-api-key` in smoke POST requests.
3. Run focused ML/privacy smokes, aggregate smoke, and the canonical repository gate.
