import json,sys
for l in sys.stdin:
    if not l.startswith('{'): continue
    r=json.loads(l); a=r['alass']; c=r['claudesynchro']
    print(f"{r['case']:34} n={r['lines']:4} | alass 0.5s={a['within_0.5s']:.3f} drop={a['dropped_ok']:>6} | claude 0.5s={c.get('within_0.5s',0):.3f} 1s={c.get('within_1s',0):.3f} wrongdrop={c.get('wrongly_dropped','-')} drop={c.get('dropped_ok','-'):>6} fill={c.get('filled','-')} cuts={c.get('cuts','-')} conf={c.get('confidence','-')} {c.get('error','')}")
