#!/usr/bin/env bash
# Free, dependency-free test run:  bash test/run.sh
set -e
cd "$(dirname "$0")/.."
python3 - << 'PY'
s=open("index.html").read()
i=s.rfind('<script>\n/* ============ CONFIG'); j=s.rfind('</script>')
js=s[i+8:j]; k=js.rfind("\nboot();")
js=js[:k]+"\n/* boot disabled in tests */"+js[k+len("\nboot();"):]
open("/tmp/app_test.js","w").write(js)
PY
cat test/stubs.js /tmp/app_test.js test/asserts.js > /tmp/run.js
node /tmp/run.js
