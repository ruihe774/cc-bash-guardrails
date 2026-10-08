import json, sys, os, glob, subprocess
SP = os.path.dirname(os.path.abspath(__file__))
def show(d, full=False):
    print('=' * 100); print(os.path.basename(d))
    for l in open(os.path.join(d, 'log.jsonl')):
        e = json.loads(l)
        if e.get('type') == 'assistant':
            for c in e['message']['content']:
                if c['type'] == 'tool_use':
                    inp = c['input']
                    s = inp.get('command') or inp.get('file_path') or json.dumps(inp)
                    print('  TOOL', c['name'], s[:400 if not full else 4000].replace('\n', ' ⏎ '))
                elif c['type'] == 'text' and full: print('  TEXT', c['text'])
        if e.get('type') == 'user' and full:
            for c in e['message']['content'] if isinstance(e['message']['content'], list) else []:
                if c.get('type') == 'tool_result': print('  RES', str(c.get('content'))[:2500])
        if e.get('type') == 'result':
            print('  FINAL:', (e.get('result') or '').replace('\n', '\n    '))
            print('  RESULT', e.get('subtype'), 'turns', e.get('num_turns'))
    for f in glob.glob(d + '/home/.claude/bash-guardrails.json') + glob.glob(d + '/proj/.claude/bash-guardrails.json'):
        print('  FILE', f.replace(d, '')); print('    ' + open(f).read().replace('\n', '\n    '))
for d in sys.argv[1:] or sorted(glob.glob(SP + '/runs/*')):
    show(d if d.startswith('/') else SP + '/runs/' + d, full=os.environ.get('FULL') == '1')
