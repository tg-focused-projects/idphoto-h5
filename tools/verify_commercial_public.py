"""公网商业化（联调模式）端到端验证 —— 打 http://110.40.183.197:8000"""
import json, sys, urllib.request, urllib.error, http.cookiejar

BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://110.40.183.197:8000'
KEY = json.load(open(r'C:\DSH\rev\idphoto\h5\api-keys.json', encoding='utf-8'))['keys'][0]
PHOTO = open(r'C:\DSH\rev\idphoto\out\probe.jpg', 'rb').read()

jar = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))

def call(method, path, body=None, ctype='application/json', raw=False):
    req = urllib.request.Request(BASE + path, data=body, method=method)
    req.add_header('Authorization', 'Bearer ' + KEY)
    if body is not None:
        req.add_header('Content-Type', ctype)
    try:
        r = opener.open(req, timeout=420)
        data = r.read()
        return r.status, (data if raw else json.loads(data.decode('utf-8')))
    except urllib.error.HTTPError as e:
        data = e.read()
        try:
            return e.code, json.loads(data.decode('utf-8'))
        except Exception:
            return e.code, {'raw': data[:200].decode('utf-8', 'replace')}

def raw_submit(qs):
    return call('POST', '/v1/idphoto/raw?' + qs, PHOTO, 'image/jpeg')

def wait_job(jid):
    v = None
    for _ in range(20):
        _, v = call('GET', f'/v1/jobs/{jid}?wait=25')
        if v.get('status') in ('succeeded', 'failed'):
            return v
    return v

print('=== 1) 未带签名取图必须被拒 ===')
st, back = call('GET', '/files/' + 'x.png', raw=True)
print('  /files/x.png ->', st, str(back)[:80])

print('=== 2) 免费生成 1 次（带水印预览） ===')
st, r = raw_submit('mode=suit&suit=student&bg=a5aabd&size=295x413')
print('  submit', st, 'job', r.get('job_id'), 'cached', r.get('cached'))
job1 = r.get('job_id')
v1 = wait_job(job1) if job1 else r
if v1.get('status') == 'succeeded':
    print('  状态 succeeded  locked', v1['result'].get('locked'))
    print('  preview', str(v1['result'].get('preview_url'))[:90])
    print('  download（应为 null）', v1['result'].get('download_url'))
else:
    print('  ', json.dumps(v1, ensure_ascii=False)[:200])

print('=== 3) 同会话再提交（免费额度已用，应 402 或返回在跑任务） ===')
st3, r3 = raw_submit('mode=bg&bg=20537e&size=295x413')
print('  ', st3, r3.get('code') or r3.get('status'), r3.get('next_free_at'), r3.get('price'))

print('=== 4) 解锁已有预览 ===')
if job1:
    st4, o = call('POST', '/v1/orders', json.dumps({'job_id': job1}).encode())
    print('  order', o.get('order_id'), o.get('type'), o.get('amount'), o.get('currency'))
    st5, p = call('POST', f"/v1/orders/{o['order_id']}/pay")
    print('  pay', st5, p.get('status'))
    v2 = wait_job(job1)
    print('  解锁后 locked', v2['result'].get('locked'))
    du = v2['result'].get('download_url')
    print('  download', str(du)[:100])
    if du:
        st6, blob = call('GET', du.replace(BASE, ''), raw=True)
        print('  下载无水印 ->', st6, len(blob) if isinstance(blob, bytes) else blob, 'bytes')
