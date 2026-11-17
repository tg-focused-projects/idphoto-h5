import json, os, sys, urllib.request

key = open(os.path.expanduser('~/.dsh/chatgpt2api-native/admin-key'), encoding='utf-8').read().strip()  # unused
ghkey = None
# GitHub token 从凭据管理器由外部传入；这里只做只读抓取，用环境变量 GH_TOKEN
ghkey = os.environ.get('GH_TOKEN', '')

def api(path):
    req = urllib.request.Request('https://api.github.com' + path, headers={
        'Authorization': 'Bearer ' + ghkey,
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'dsh-cli',
    })
    return json.load(urllib.request.urlopen(req, timeout=30))

for n in (2, 3, 4):
    try:
        i = api('/repos/tg-focused-projects/idphoto-h5/issues/%d' % n)
    except Exception as e:
        print('## issue %d 抓取失败: %s' % (n, e))
        continue
    print('=' * 70)
    print('#%d  %s' % (n, i['title']))
    print('state=%s  author=%s  comments=%d  labels=%s  created=%s' % (
        i['state'], i['user']['login'], i['comments'], ','.join(l['name'] for l in i['labels']), i['created_at']))
    print('-' * 70)
    print(i['body'] or '(空)')
    if i['comments']:
        print('-' * 70)
        for c in api('/repos/tg-focused-projects/idphoto-h5/issues/%d/comments' % n):
            print('[comment %s] %s' % (c['created_at'], c['user']['login']))
            print(c['body'])
            print('-' * 70)
