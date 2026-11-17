"""商业化流程端到端验证（临时实例 8012，COMMERCIAL=1）"""
import json, socket, time, sys, urllib.request, http.cookiejar, os

BASE = 'http://127.0.0.1:8012'
KEY = open(r'C:\DSH\rev\idphoto\h5\api-keys.json', encoding='utf-8').read()
KEY = json.loads(KEY)['keys'][0]
PHOTO = open(r'C:\DSH\rev\idphoto\out\probe.jpg', 'rb').read()

jar = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))

def call(method, path, body=None, ctype='application/json'):
    req = urllib.request.Request(BASE + path, data=body, method=method)
    req.add_header('Authorization', 'Bearer ' + KEY)
    if body is not None:
        req.add_header('Content-Type', ctype)
    try:
        r = opener.open(req, timeout=420)
        return r.status, json.loads(r.read().decode('utf-8'))
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode('utf-8'))

def raw_submit(qs):
    return call('POST', '/v1/idphoto/raw?' + qs, PHOTO, 'image/jpeg')

def wait_job(jid):
    for _ in range(20):
        st, v = call('GET', f'/v1/jobs/{jid}?wait=25')
        if v.get('status') in ('succeeded', 'failed'):
            return v
    return v

print('=== 1) 免费生成 ===')
st, r = raw_submit('mode=suit&suit=women-shirt&bg=ff0000&size=295x413')
print('  submit', st, 'job', r.get('job_id'), 'cached', r.get('cached'))
if r.get('job_id'):
    v = wait_job(r['job_id'])
    print('  状态', v['status'], 'locked', v['result'].get('locked'), 'usedAt', (v['result'].get('quota') or {}).get('usedAt'))
    print('  preview', str(v['result'].get('preview_url'))[:80])
    print('  download', v['result'].get('download_url'))
    job1 = r['job_id'] if v['status'] == 'succeeded' else None
else:
    job1 = None
    print('  ', json.dumps(r, ensure_ascii=False)[:200])

print('=== 2) 同会话第二次提交（期望 402）===')
st2, r2 = raw_submit('mode=bg&bg=20537e&size=295x413')
print('  ', st2, r2.get('code'), 'next_free_at', r2.get('next_free_at'), 'price', r2.get('price'))

print('=== 3) 付费买「新照片」额度 ===')
st3, o = call('POST', '/v1/orders', json.dumps({'type': 'new_photo'}).encode())
print('  order', o.get('order_id'), o.get('amount'), o.get('currency'))
st4, p = call('POST', f"/v1/orders/{o['order_id']}/pay")
print('  支付后', p.get('status'), 'credits', p['quota']['credits'])

print('=== 4) 用付费额度生成 ===')
st5, r5 = raw_submit('mode=suit&suit=navy-suit&bg=cce9fc&size=295x413')
print('  submit', st5, 'job', r5.get('job_id'))
job2 = r5.get('job_id')
if job2:
    v2 = wait_job(job2)
    print('  状态', v2['status'], 'locked', v2['result'].get('locked'), 'credits', (v2['result'].get('quota') or {}).get('credits'))
    print('  download（未付费解锁应为空）:', v2['result'].get('download_url'))
    print('=== 5) 下单解锁这张 ===')
    st6, o2 = call('POST', '/v1/orders', json.dumps({'job_id': job2}).encode())
    print('  order', o2.get('order_id'), 'type', o2.get('type'))
    st7, p2 = call('POST', f"/v1/orders/{o2['order_id']}/pay")
    print('  支付后', p2.get('status'))
    v3 = wait_job(job2)
    print('  解锁后 locked', v3['result'].get('locked'))
    print('  download', str(v3['result'].get('download_url'))[:100])
    du = v3['result'].get('download_url')
    if du:
        try:
            rr = urllib.request.urlopen(du, timeout=60)
            print('  下载无水印 ->', rr.status, len(rr.read()), 'bytes')
        except Exception as e:
            print('  下载失败', e)
