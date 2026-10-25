import os,re,sys,datetime
for out in sys.argv[1:]:
    try:
        init=float(re.search(r'init=([\d.]+)',open(out+'/times.txt').read()).group(1))
        t0=os.path.getmtime(out+'/init.log')-init
        for line in open(out+'/log-b/adapter.log'):
            if 'stale_assumption' in line or 'reject' in line:
                ts=datetime.datetime.fromisoformat(line.split()[0].replace('Z','+00:00')).timestamp()
                print(out, 'first squiggle at', round(ts-t0,1),'s'); break
        else: print(out,'no squiggle in adapter.log')
    except Exception as e: print(out,'err',e)
