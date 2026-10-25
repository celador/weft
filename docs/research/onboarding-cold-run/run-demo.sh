#!/bin/bash
# cold `weft demo` run with Claude Code: clean HOME for Weft, real HOME for claude's login
set -u
R=/tmp/weft-cold; OUT=$R/out/demo; rm -rf $R/d $OUT; mkdir -p $R/d $OUT
export PATH=/opt/homebrew/opt/node@24/bin:$PATH
now() { python3 -c 'import time;print(f"{time.time():.1f}")'; }
T0=$(now)
( export HOME=$R/home; cd $R/d && ${WEFT_BIN:-npx -y @celador/weft@latest} demo --yes --no-open ) > $OUT/init.log 2>&1
T1=$(now)
PA=$(grep -A2 "Make them collide" $OUT/init.log | sed -n 2p | sed 's/^[^:]*: //')
PB=$(grep -A2 "Make them collide" $OUT/init.log | sed -n 3p | sed 's/^[^:]*: //')
echo "PA=$PA" > $OUT/prompts.txt; echo "PB=$PB" >> $OUT/prompts.txt
( cd $R/d/weft-demo && claude -p "$PA" --permission-mode acceptEdits --max-turns 25 ) > $OUT/a.log 2>&1 < /dev/null; echo "a exit $?" >> $OUT/a.log
T2=$(now)
( cd $R/d/weft-demo-2 && claude -p "$PB" --permission-mode acceptEdits --max-turns 25 ) > $OUT/b.log 2>&1 < /dev/null; echo "b exit $?" >> $OUT/b.log
T3=$(now)
( export HOME=$R/home; cd $R/d/weft-demo && ${WEFT_BIN:-npx -y @celador/weft@latest} status ) > $OUT/status.log 2>&1
cp -r $R/d/weft-demo-2/.weft/log $OUT/log-b 2>/dev/null
(cd $R/d/weft-demo && git diff) > $OUT/a.diff; (cd $R/d/weft-demo-2 && git diff) > $OUT/b.diff
echo "init=$(python3 -c "print(round($T1-$T0,1))") a=$(python3 -c "print(round($T2-$T1,1))") b=$(python3 -c "print(round($T3-$T2,1))") total=$(python3 -c "print(round($T3-$T0,1))")" | tee $OUT/times.txt
