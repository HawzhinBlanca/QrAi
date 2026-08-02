"""`/v1/force-align` must answer 501 when this image cannot align, not 500.

    python test_force_align_unavailable.py

Why: `forced_align._load` imports `transformers` lazily, and the shipped Dockerfile deliberately
does NOT install it. So in the image we actually ship, every call to this endpoint raised
ImportError, fell into the generic `except Exception`, and returned:

    500 {"detail": "force alignment failed"}

A 500 tells an operator the server broke and a retry may help. The truth is that this deployment
cannot perform the operation at all — a build decision someone made and can reverse. That is 501.

── What this test is, and is not ───────────────────────────────────────────────────────────────
A SOURCE check. Importing `server.py` pulls in fastapi and torch, which the other tests in this
directory deliberately avoid so they run anywhere — `test_forced_align_normalization.py` reads the
source for the same reason. So this asserts the handler's structure, not its behaviour under a
real request, and would not notice a new code path that raised ImportError somewhere else.
The behavioural version needs the image itself and belongs in a smoke test against a running
container.
"""
import re
import sys

SRC = open("server.py", encoding="utf-8").read()

# The force_align handler: from its decorator to the next top-level `@app.` decorator.
_START = SRC.index('@app.post(\n    "/v1/force-align"')
_REST = SRC[_START:]
_END = _REST.index("\n@app.", 1)
HANDLER = _REST[:_END]

failures = []


def check(name, ok, detail=""):
    if ok:
        print(f"  ok   {name}")
    else:
        failures.append(name)
        print(f"  FAIL {name}{(' — ' + detail) if detail else ''}")


print("force-align availability:")

check(
    "the handler catches ImportError explicitly",
    re.search(r"^    except ImportError:", HANDLER, re.M) is not None,
    "a missing alignment dependency still falls into the generic 500",
)

check(
    "it answers 501",
    "status_code=501" in HANDLER,
    "found no 501; a capability this build lacks must not be reported as a fault",
)

_import_block = re.search(r"    except ImportError:(.*?)\n    except ", HANDLER, re.S)
check(
    "the ImportError branch does NOT return 500",
    _import_block is not None and "status_code=500" not in _import_block.group(1),
)

check(
    "ImportError is caught BEFORE the generic Exception",
    HANDLER.index("except ImportError:") < HANDLER.index("except Exception:"),
    "Python takes the first matching handler; after the generic one it is unreachable",
)

# The Dockerfile is the reason this branch exists. If transformers is ever installed, the endpoint
# starts working and this test should be revisited rather than silently kept.
DOCKERFILE = open("Dockerfile", encoding="utf-8").read()
check(
    "the Dockerfile still omits transformers, which is why 501 is the honest answer",
    not re.search(r"^\s*RUN pip install[^\n]*transformers", DOCKERFILE, re.M),
    "transformers now appears installed — if force-align works, remove the 501 branch",
)

print(f"\n{len(failures)} failed" if failures else "\nall passed")
sys.exit(1 if failures else 0)
