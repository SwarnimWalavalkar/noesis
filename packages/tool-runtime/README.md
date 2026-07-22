# Generated-tool runtime

This package is a research-preview execution boundary, not a production sandbox.

The local backend runs one generated JavaScript module in a fresh temporary directory and child process. It
passes a small sanitized environment, bounds time, output, and JSON-RPC traffic, validates declared input and
output schemas, captures source and trace artifacts, and exposes external effects only through a trusted parent
broker. The broker retains `EffectGateway` grants and receipts; generated code never receives them or provider
credentials.

The child still runs on the host and can reach Node built-ins. Use this backend only for trusted local research.
The `GeneratedToolBackend` port is the replacement seam for a container, VM, Node-permission, or OS-sandbox
backend before running less-trusted code. Broader write, network, or execute authority remains an approval and
policy concern outside generated content.
