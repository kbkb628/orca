#!/bin/sh
# usage: run.sh <repo>; bundles daemon + driver from the repo's sources and runs the relay proof.
set -e
R=$1; P=$R/.relay-proof
mkdir -p $P && cp "$(dirname "$0")"/agent.js "$(dirname "$0")"/daemon.ts "$(dirname "$0")"/driver.ts $P/
cd $R
for f in daemon driver; do
  node_modules/.bin/esbuild $P/$f.ts --bundle --platform=node --format=cjs --packages=external --outfile=$P/$f.cjs --log-level=warning
done
node $P/driver.cjs
