"""从 FlClash 的 profile 生成我们自己的 mihomo 配置（只保留真实节点）

  python tools/make_mihomo_config.py [profile路径]

为什么不用原配置：机场订阅里塞了「剩余流量 / 套餐到期」这类说明性节点，
原 url-test 会选中它们 → 所有流量打到假节点 → 502。
这里用 YAML 解析器精确过滤，并且用我们自己的 PROXY(select) + AUTO(url-test)。
"""
import os
import re
import sys
import yaml

HOME = os.environ.get('USERPROFILE', r'C:\Users\Administrator')
PROFILE_DIR = os.path.join(HOME, 'AppData', 'Roaming', 'com.follow', 'clash', 'profiles')
OUT_DIR = r'C:\DSH\tools\mihomo'
MIXED = int(os.environ.get('MIHOMO_MIXED_PORT', '7891'))
CTRL = os.environ.get('MIHOMO_CONTROLLER', '127.0.0.1:9099')
SECRET = os.environ.get('MIHOMO_SECRET', 'idphoto-local-2026')
FAKE = re.compile('剩余流量|距离下次重置|套餐到期|官网|过期|到期时间|流量重置|客服|TG群|电报群')


def newest_profile():
    if len(sys.argv) > 1:
        return sys.argv[1]
    cands = []
    for f in os.listdir(PROFILE_DIR):
        if not f.lower().endswith(('.yaml', '.yml')):
            continue
        p = os.path.join(PROFILE_DIR, f)
        if os.path.getsize(p) > 2000:
            cands.append((os.path.getmtime(p), p))
    if not cands:
        raise SystemExit('没找到可用的 profile')
    return max(cands)[1]


src = newest_profile()
with open(src, encoding='utf-8') as fh:
    cfg = yaml.safe_load(fh) or {}

proxies = cfg.get('proxies') or []
real = [p for p in proxies if p.get('name') and not FAKE.search(p['name'])]
dropped = [p.get('name') for p in proxies if p.get('name') and FAKE.search(p['name'])]
if not real:
    raise SystemExit('过滤后没有可用节点')

names = [p['name'] for p in real]

out = {
    'mixed-port': MIXED,
    'allow-lan': False,
    'mode': 'rule',
    'log-level': 'warning',
    'ipv6': False,
    'external-controller': CTRL,
    'secret': SECRET,
    'dns': {
        'enable': True,
        'ipv6': False,
        'enhanced-mode': 'fake-ip',
        'fake-ip-range': '198.18.0.1/16',
        'default-nameserver': ['223.5.5.5', '119.29.29.29'],
        'nameserver': ['223.5.5.5', '119.29.29.29', '1.1.1.1'],
    },
    'profile': {'store-selected': True, 'store-fake-ip': True},
    'proxies': real,
    'proxy-groups': [
        {'name': 'PROXY', 'type': 'select', 'proxies': ['AUTO'] + names},
        {
            'name': 'AUTO',
            'type': 'url-test',
            'url': 'https://www.gstatic.com/generate_204',
            'interval': 180,
            'tolerance': 80,
            'lazy': False,
            'proxies': names,
        },
    ],
    'rules': [
        # 国内直连：这样 7891 也能当系统代理用，不会把国内流量绕出国
        'DOMAIN-SUFFIX,cn,DIRECT',
        'DOMAIN-SUFFIX,qq.com,DIRECT',
        'DOMAIN-SUFFIX,weixin.qq.com,DIRECT',
        'DOMAIN-SUFFIX,wechat.com,DIRECT',
        'DOMAIN-SUFFIX,gtimg.com,DIRECT',
        'DOMAIN-SUFFIX,qpic.cn,DIRECT',
        'DOMAIN-SUFFIX,baidu.com,DIRECT',
        'DOMAIN-SUFFIX,bdstatic.com,DIRECT',
        'DOMAIN-SUFFIX,aliyun.com,DIRECT',
        'DOMAIN-SUFFIX,alicdn.com,DIRECT',
        'DOMAIN-SUFFIX,taobao.com,DIRECT',
        'DOMAIN-SUFFIX,tmall.com,DIRECT',
        'DOMAIN-SUFFIX,jd.com,DIRECT',
        'DOMAIN-SUFFIX,163.com,DIRECT',
        'DOMAIN-SUFFIX,bilibili.com,DIRECT',
        'DOMAIN-SUFFIX,zhihu.com,DIRECT',
        'DOMAIN-SUFFIX,douyin.com,DIRECT',
        'DOMAIN-SUFFIX,weibo.com,DIRECT',
        'DOMAIN-SUFFIX,mi.com,DIRECT',
        'DOMAIN-SUFFIX,qqmail.com,DIRECT',
        'IP-CIDR,10.0.0.0/8,DIRECT,no-resolve',
        'IP-CIDR,172.16.0.0/12,DIRECT,no-resolve',
        'IP-CIDR,192.168.0.0/16,DIRECT,no-resolve',
        'IP-CIDR,127.0.0.0/8,DIRECT,no-resolve',
        'MATCH,PROXY',
    ],
}

os.makedirs(OUT_DIR, exist_ok=True)
dst = os.path.join(OUT_DIR, 'config.yaml')
with open(dst, 'w', encoding='utf-8') as fh:
    yaml.safe_dump(out, fh, allow_unicode=True, sort_keys=False, default_flow_style=False, width=4096)

print(f'  来源: {os.path.basename(src)}  {os.path.getsize(src)//1024}KB')
print(f'  真实节点 {len(real)} 个；丢弃说明性节点 {len(dropped)} 个' + (f'：{" | ".join(dropped[:5])}' if dropped else ''))
print(f'  已写入 {dst}  {os.path.getsize(dst)//1024}KB')
print('  节点: ' + ' | '.join(names[:6]) + (' …' if len(names) > 6 else ''))
