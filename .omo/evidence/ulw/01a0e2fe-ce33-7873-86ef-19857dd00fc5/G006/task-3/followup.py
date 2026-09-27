#!/usr/bin/env python3
import json, sys, time, urllib.request, urllib.error
from pathlib import Path
ROOT = Path("/Users/gahn/projects/impromptu-rev2")
EVID = ROOT/".omo/evidence/ulw/01a0e2fe-ce33-7873-86ef-19857dd00fc5/G006/task-3"
BASE = "http://127.0.0.1:3001"
env = {}
for line in (ROOT/".env").read_text().splitlines():
    if "=" in line and not line.startswith("#"):
        k,v = line.split("=",1); env[k]=v.strip().strip('"').strip("'")
import subprocess
ORIGIN = subprocess.check_output(["docker","exec","impromptu-ulw-g003-demo-private-backend-1","printenv","CONSOLE_ORIGIN"], text=True).strip()

def req(method, path, body=None, headers=None, cookies=None, timeout=90):
    h = {"Origin": ORIGIN, "Referer": ORIGIN+"/"}
    if headers: h.update(headers)
    if cookies: h["Cookie"] = "; ".join(f"{k}={v}" for k,v in cookies.items())
    data = None
    if isinstance(body,(bytes,bytearray)): data = bytes(body)
    elif body is not None:
        data = json.dumps(body).encode(); h.setdefault("Content-Type","application/json")
    t=time.monotonic()
    r = urllib.request.Request(BASE+path, data=data, method=method, headers=h)
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            return resp.status, dict(resp.headers), resp.read(), int((time.monotonic()-t)*1000)
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read(), int((time.monotonic()-t)*1000)

out=[]
def log(s): out.append(s); print(s, flush=True)

PS1 = "ps_65e46f125869e1857a017fe7c6f9af3f"   # audio probe session (ended, qa-provisioned)
PS2 = "ps_09bd03be04385ef0ce59aa41c84530ad"   # scanned upload session (still ACTIVE)

log("## follow-up: re-login")
s,h,p,ms = req("POST","/v1/account-sessions",body={"username":env["CONTROLLER_USERNAME"],"password":env["CONTROLLER_PASSWORD"]})
log(f"login HTTP {s} in {ms}ms")
cookie=[v for k,v in h.items() if k.lower()=="set-cookie" and "__Host-account=" in v][0].split(";",1)[0].split("=",1)[1]
csrf=json.loads(p)["csrfToken"]
cookies={"__Host-account":cookie}; mut={"x-csrf-token":csrf}

log(f"## GET /report for {PS1} (post-qa-exchange; row now provisioned)")
s,h,p,ms = req("GET",f"/v1/presentation-sessions/{PS1}/report",cookies=cookies)
log(f"HTTP {s} in {ms}ms body={p[:300]!r}")

log(f"## retry POST {PS1}/end")
s,h,p,ms = req("POST",f"/v1/presentation-sessions/{PS1}/end",headers=mut,cookies=cookies)
log(f"HTTP {s} in {ms}ms body={p[:300]!r}")

log(f"## GET /report for {PS1}")
for i in range(15):
    s,h,p,ms = req("GET",f"/v1/presentation-sessions/{PS1}/report",cookies=cookies)
    if s==200: break
    log(f"  attempt {i}: HTTP {s} {p[:120]!r}")
    time.sleep(1.0)
log(f"final: HTTP {s} in {ms}ms")
if s==200:
    rep=json.loads(p)
    r=rep.get("report",rep)
    log(f"report keys={sorted(r.keys())}")
    log(f"speech={json.dumps(r.get('speech'))[:300]}")
    log(f"coaching={json.dumps(r.get('coaching'))[:800]}")
    log(f"qaExchanges={json.dumps(r.get('qaExchanges', r.get('qa')))[:800]}")

log(f"## end {PS2} (scanned; never visited, no QA)")
s,h,p,ms = req("POST",f"/v1/presentation-sessions/{PS2}/end",headers=mut,cookies=cookies)
log(f"HTTP {s} in {ms}ms body={p[:200]!r}")
s,h,p,ms = req("GET",f"/v1/presentation-sessions/{PS2}/report",cookies=cookies)
log(f"GET report -> HTTP {s} body={p[:200]!r}")

log("## logout")
s,h,p,ms = req("DELETE","/v1/account-session",headers=mut,cookies=cookies)
log(f"HTTP {s} body={p[:120]!r}")
(EVID/"followup.log").write_text("\n".join(out)+"\n")
