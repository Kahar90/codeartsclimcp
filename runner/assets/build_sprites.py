import json
from pathlib import Path
from PIL import Image, ImageDraw

root = Path(__file__).resolve().parent
outline = '#211629'
skin = '#ffc789'
shadow = '#bd765f'
roles = {
    'lead': ('#ba7de6', '#6a3c94', '#e8bafa'),
    'builder': ('#79e3ef', '#306688', '#d2faff'),
    'artist': ('#ffc05a', '#ab5a36', '#ffe399'),
    'reviewer': ('#8cce83', '#46795d', '#c4f0a3'),
    # Hot-desk workers: lanes beyond the three main stations. Builder robot body, own colour each.
    'hot1': ('#ff9ec7', '#9c3d6e', '#ffd6ea'),
    'hot2': ('#9fb4ff', '#3f4f9e', '#dbe3ff'),
    'hot3': ('#c8f07a', '#5d7d2c', '#ecffc4'),
    'hot4': ('#ffb07a', '#a3532a', '#ffe0c4'),
    'hot5': ('#d4a6ff', '#6b3fa0', '#f0deff'),
}
# Hot-desk workers by lane kind: robots code (hot1..5), painters do UI/art, inspectors review/test,
# writers do docs. Five colours each, so no two neighbours look alike.
HOT_PALETTES = [('#ff9ec7', '#9c3d6e', '#ffd6ea'), ('#9fb4ff', '#3f4f9e', '#dbe3ff'), ('#c8f07a', '#5d7d2c', '#ecffc4'),
                ('#ffb07a', '#a3532a', '#ffe0c4'), ('#d4a6ff', '#6b3fa0', '#f0deff')]
for kind in ('painter', 'inspector', 'writer'):
    for i, pal in enumerate(HOT_PALETTES):
        roles[f'{kind}{i + 1}'] = pal
SHAPES = {'hot': 'builder', 'painter': 'artist', 'inspector': 'reviewer', 'writer': 'writer'}
def shape_of(role):
    for pre, shape in SHAPES.items():
        if role.startswith(pre) and role[len(pre):].isdigit():
            return shape
    return role
sequences = {
    'idle': [1800, 85, 115, 2300],
    'work': [125, 95, 90, 120, 100, 95, 110, 270],
    'receive': [85, 90, 100, 135, 170],
    'complete': [100, 85, 95, 115, 150, 170],
    'blocked': [250, 1500],
}
cell, stride, columns = 64, 66, 8

def sprite(role, clip, frame):
    shape = shape_of(role)
    im = Image.new('RGBA', (cell, cell))
    d = ImageDraw.Draw(im)
    color, dark, light = roles[role]
    blink = clip == 'idle' and frame == 1
    lift = [0, 1, 2, 3, 2, 1][frame] if clip == 'complete' else 0
    motion = [0,1,2,3,2,1,0,0][frame] if clip == 'work' else [0,2,4,2,0][frame] if clip == 'receive' else lift
    y = -lift if shape != 'builder' else 0

    def poly(points, fill, edge=outline):
        d.polygon(points, fill=fill, outline=edge)

    def box(bounds, fill, edge=None):
        d.rectangle(bounds, fill=fill, outline=edge)

    def line(points, fill, width=1):
        d.line(points, fill=fill, width=width)

    d.ellipse((10,55,54,60), fill='#39263c75')
    poly([(20,46),(41,46),(44,53),(47,54),(47,57),(34,57),(31,51),(28,57),(15,57),(15,54),(19,52)], '#494365')
    box((17,54,26,55),'#737195')
    box((36,54,45,55),'#737195')
    poly([(21,31+y),(39,31+y),(45,36+y),(43,49),(37,52),(22,51),(17,46),(17,38+y)],dark)
    box((23,36+y,38,45+y),color,outline)
    line([(25,38+y),(35,38+y)],light,2)

    if shape == 'builder':
        line([(30,13),(30,7),(34,7)],outline,3)
        box((33,4,37,8),light,outline)
        hot = role.startswith('hot')
        poly([(19,14),(36,11),(44,15),(47,20),(46,31),(41,36),(23,37),(15,32),(14,22)], dark if hot else '#91b3c5')
        poly([(21,14),(36,13),(43,17),(44,27),(38,33),(23,33),(18,28),(18,21)], color if hot else '#e2f1e9')
        poly([(23,19),(38,18),(42,21),(42,28),(38,31),(24,31),(21,28),(21,22)],'#133345')
        box((13,21,18,28),color,outline)
        if blink:
            line([(25,26),(29,26)],light)
            line([(34,26),(38,26)],light)
        elif clip == 'blocked':
            line([(25,24),(29,27),(25,27)],'#ffac8f')
            line([(34,27),(38,24),(38,27)],'#ffac8f')
        else:
            line([(25,26),(25,23),(28,23),(28,26)],light)
            line([(34,26),(34,23),(37,23),(37,26)],light)
        for i in range(2):
            wrist = (38+i*9+((frame+i)%2 if clip=='work' else 0),48-((motion+i)%4))
            elbow = (19+22*i,40)
            line([elbow,wrist],outline,7)
            line([elbow,wrist],color,4)
            box((wrist[0]-1,wrist[1]-1,wrist[0]+4,wrist[1]+2),light,outline)
        poly([(31,49),(51,47),(56,50),(53,55),(31,56),(26,53)],'#42677d')
        line([(32,51),(51,50)], '#b9e2da')
        if clip=='work':
            box((34+motion*4,51,36+motion*4,52),color)
    else:
        poly([(16,20+y),(20,13+y),(29,10+y),(40,13+y),(46,20+y),(45,30+y),(40,36+y),(25,36+y),(18,32+y)],dark)
        poly([(21,21+y),(39,21+y),(43,25+y),(41,32+y),(36,36+y),(26,35+y),(21,30+y)],skin)
        box((22,29+y,24,31+y),shadow)
        box((38,29+y,40,30+y),'#e89274')
        if blink:
            line([(26,27+y),(29,27+y)],outline)
            line([(35,27+y),(38,27+y)],outline)
        else:
            box((27,25+y,28,28+y),outline)
            box((36,25+y,37,28+y),outline)
        line([(31,31+y),(34,31+y)],shadow)
        if shape == 'artist':
            poly([(15,20+y),(17,14+y),(26,9+y),(39,9+y),(46,14+y),(47,18+y),(37,22+y),(20,22+y)],color)
            line([(22,15+y),(27,12+y),(39,12+y)],light,2)
            poly([(20,21+y),(42,18+y),(49,21+y),(43,23+y),(28,24+y)],dark)
            poly([(35,45),(52,41),(58,47),(55,54),(35,57),(31,52)],'#524773')
            line([(39,51),(43,47),(48,49),(52,46)],'#ecc7fa',1)
            if clip == 'work':
                line([(39,51),(43,47),(43+motion*2,47+motion)],light,1)
            hand = (41+motion,44-motion)
            line([(24,39+y),(31,46),hand],outline,8)
            line([(24,39+y),(31,46),hand],skin,5)
            line([(hand[0]-4,hand[1]-12),(hand[0]+5,hand[1]+5)],outline,5)
            line([(hand[0]-4,hand[1]-11),(hand[0]+4,hand[1]+3)],color,3)
        elif shape == 'writer':
            # hair with a side part, round glasses, an open notebook and a pen that writes while working
            poly([(15,22+y),(17,14+y),(25,9+y),(38,9+y),(46,15+y),(47,22+y),(41,17+y),(30,16+y),(22,19+y),(19,25+y)],color)
            line([(21,14+y),(27,11+y),(37,11+y)],light,2)
            for gx in (24, 33):
                d.rectangle((gx,23+y,gx+6,29+y),outline=outline)
            line([(30,26+y),(33,26+y)],outline)
            bk = 43
            poly([(17,bk),(32,bk+4),(32,bk+13),(17,bk+9)],'#f3ead8')
            poly([(32,bk+4),(47,bk),(47,bk+9),(32,bk+13)],'#e6dcc6')
            line([(32,bk+4),(32,bk+13)],dark)
            line([(16,bk+10),(32,bk+14),(48,bk+10)],dark,2)
            grow = (motion if clip == 'work' else 3)
            for i in range(3):
                line([(20,bk+3+i*2),(28,bk+5+i*2)],'#b9ad98')
                line([(35,bk+4+i*2),(35+min(9, 3+grow*2-i),bk+2+i*2)],'#b9ad98')
            hand = (40+motion, 44-motion//2)
            line([(26,39+y),(33,45),hand],outline,8)
            line([(26,39+y),(33,45),hand],skin,5)
            line([(hand[0]+1,hand[1]+1),(hand[0]+6,hand[1]-8)],outline,4)
            line([(hand[0]+1,hand[1]+1),(hand[0]+5,hand[1]-7)],'#3b3f55',2)
            box((hand[0]+5,hand[1]-9,hand[0]+6,hand[1]-8),light)
        elif shape == 'lead':
            poly([(15,21+y),(16,15+y),(21,15+y),(24,9+y),(29,13+y),(35,9+y),(43,14+y),(47,20+y),(41,24+y),(36,18+y),(30,23+y),(24,20+y),(20,24+y)],color)
            line([(18,16+y),(24,15+y),(28,12+y)],light)
            plan = -motion
            poly([(22,40+plan),(49,34+plan),(52,48+plan),(24,55+plan)],'#744cb1')
            line([(26,42+plan),(45,38+plan),(48,45+plan),(29,50+plan),(26,42+plan)],light)
            line([(32,41+plan),(35,47+plan),(40,46+plan),(39,43+plan),(46,41+plan)],'#caa6fc')
            box((21,45+plan,26,49+plan),skin,outline)
            box((48,41+plan,52,45+plan),skin,outline)
        else:
            poly([(15,22+y),(18,15+y),(22,14+y),(26,9+y),(35,9+y),(42,14+y),(47,15+y),(49,20+y),(43,23+y)],color)
            line([(22,15+y),(28,12+y),(35,12+y)],light,2)
            for x in (25,35):
                d.ellipse((x,15+y,x+8,22+y), fill='#6aa2a3', outline=outline)
                line([(x+2,18+y),(x+4,16+y)],light)
            x, lens_y = 47+motion, 36+y-motion
            line([(28,42+y),(36,46),(x-3,lens_y+6)],outline,8)
            line([(28,42+y),(36,46),(x-3,lens_y+6)],skin,5)
            line([(x-5,lens_y+8),(x,lens_y)],outline,4)
            d.ellipse((x-6,lens_y-8,x+7,lens_y+5),fill='#79a3af',outline=outline,width=2)
            line([(x-3,lens_y-3),(x+2,lens_y-5)],'#eaf8e3')
    if clip == 'receive' and frame in (1,2,3):
        for px,py in ((44,8),(51,13),(48,4)):
            box((px,py,px+1,py+2),light)
    if clip == 'complete' and 1 <= frame <= 4:
        x, py = 48 + frame, 9 - frame
        line([(x-3,py),(x-1,py+2),(x+4,py-4)],'#bbffbc',2)
    if clip == 'blocked' and frame == 0:
        box((50,8,51,13),'#ff987c')
        box((50,15,51,16),'#ff987c')
    return im


# Hot desk prop: a small isometric desk with one monitor, drawn behind a hot-desk worker.
# Anchor = where the worker's foot anchor goes, so the monitor peeks out above the robot's head.
def hotdesk():
    W, H = 84, 74
    im = Image.new('RGBA', (W, H)); d = ImageDraw.Draw(im)
    top, side_l, side_r, leg = '#b46f3a', '#7a4426', '#5e321c', '#4a2716'
    def poly(pts, fill): d.polygon(pts, fill=fill, outline=outline)
    d.ellipse((6, 50, 78, 66), fill='#39263c55')                     # floor shadow
    for x, y in ((12, 40), (40, 54), (70, 40), (42, 28)):             # legs
        d.rectangle((x - 2, y, x + 1, y + 12), fill=leg, outline=outline)
    poly([(8, 34), (42, 18), (76, 34), (42, 50)], top)                # desk top (iso diamond)
    poly([(8, 34), (42, 50), (42, 55), (8, 39)], side_l)              # front-left edge
    poly([(42, 50), (76, 34), (76, 39), (42, 55)], side_r)            # front-right edge
    d.line([(14, 34), (42, 21), (70, 34)], fill='#d08a4e')            # top highlight
    poly([(39, 22), (45, 22), (46, 29), (38, 29)], '#3b3f55')         # monitor stand
    poly([(24, 3), (60, 3), (60, 24), (24, 24)], '#2a2f45')           # monitor bezel
    d.rectangle((27, 6, 57, 21), fill='#14303f')                      # screen
    for i, (x0, x1) in enumerate(((30, 46), (30, 52), (33, 49), (30, 42))):
        d.line([(x0, 9 + i * 3), (x1, 9 + i * 3)], fill='#5fe3d0' if i != 2 else '#ffd591')
    poly([(62, 26), (68, 26), (68, 33), (62, 33)], '#f0e6d8')         # mug
    d.line([(68, 28), (70, 30)], fill=outline)
    return im, [42, 66]

manifest = {'cell':[64,64], 'pixelScale':'nearest', 'anchor':[32,57],
            'units':'px and ms', 'roles':{}}
for role in roles:
    atlas = Image.new('RGBA', (columns*stride-2, len(sequences)*stride-2))
    clips = {}
    for row, (name, times) in enumerate(sequences.items()):
        frames = []
        for frame, duration in enumerate(times):
            x,y = frame*stride,row*stride
            atlas.paste(sprite(role,name,frame),(x,y))
            frames.append({'rect':[x,y,cell,cell], 'durationMs':duration})
        clips[name] = {'loop':name in ('idle','work','blocked'),'frames':frames,'staticFrame':1 if name=='blocked' else 0}
    path = f'atlases/{role}.png'
    atlas.save(root/path)
    manifest['roles'][role] = {'atlas':path, 'clips':clips}
# Kind props share the hot desk's frame (84x74, anchor = worker foot) so they swap freely.
def easel():
    W, H = 84, 74
    im = Image.new('RGBA', (W, H)); d = ImageDraw.Draw(im)
    def poly(pts, fill): d.polygon(pts, fill=fill, outline=outline)
    d.ellipse((10, 52, 74, 66), fill='#39263c55')
    for a, b in (((30, 30), (22, 62)), ((54, 30), (62, 62)), ((42, 26), (44, 58))):   # easel legs
        d.line([a, b], fill=outline, width=4); d.line([a, b], fill='#8a5530', width=2)
    poly([(24, 2), (60, 2), (60, 30), (24, 30)], '#f3ead8')                            # canvas
    for i, c in enumerate(('#ff9ec7', '#9fb4ff', '#c8f07a', '#ffd591', '#d4a6ff', '#79e3ef')):
        x, y = 28 + (i % 3) * 10, 6 + (i // 3) * 11
        d.rectangle((x, y, x + 7, y + 8), fill=c)
    d.rectangle((22, 30, 62, 33), fill='#6e3d22', outline=outline)                     # ledge
    poly([(60, 40), (74, 37), (78, 43), (64, 47)], '#d9b48a')                          # palette on a stool
    for x, y, c in ((65, 41, '#ff6f6f'), (69, 40, '#6fb7ff'), (72, 43, '#ffe066')):
        d.rectangle((x, y, x + 1, y + 1), fill=c)
    return im, [42, 66]

def board():
    W, H = 84, 74
    im = Image.new('RGBA', (W, H)); d = ImageDraw.Draw(im)
    def poly(pts, fill): d.polygon(pts, fill=fill, outline=outline)
    d.ellipse((12, 52, 72, 66), fill='#39263c55')
    for a, b in (((32, 30), (24, 62)), ((52, 30), (60, 62))):
        d.line([a, b], fill=outline, width=4); d.line([a, b], fill='#6e3d22', width=2)
    poly([(22, 1), (62, 1), (62, 31), (22, 31)], '#eef2e8')                            # checklist board
    d.rectangle((22, 1, 62, 4), fill='#46795d')
    for i in range(3):
        y = 8 + i * 8
        d.rectangle((26, y, 31, y + 5), fill='#8cce83', outline=outline)
        d.line([(27, y + 3), (28, y + 4), (30, y + 1)], fill='#ffffff')
        d.line([(35, y + 2), (56 - i * 5, y + 2)], fill='#9aa59a', width=2)
    poly([(64, 44), (76, 41), (78, 52), (66, 55)], '#5e321c')                          # crate with a lamp
    d.ellipse((68, 36, 75, 42), fill='#ffd591', outline=outline)
    return im, [42, 66]

def bookdesk():
    im, anchor = hotdesk()                                                             # same desk, books and a lamp
    d = ImageDraw.Draw(im)
    d.rectangle((24, 3, 60, 29), fill=(0, 0, 0, 0))                                    # clear the monitor
    d.rectangle((38, 22, 46, 29), fill=(0, 0, 0, 0))
    def poly(pts, fill): d.polygon(pts, fill=fill, outline=outline)
    for i, c in enumerate(('#9fb4ff', '#ff9ec7', '#c8f07a', '#ffd591', '#d4a6ff')):     # book stack
        y = 26 - i * 5
        poly([(20 + i % 2, y), (40 + i % 2, y), (40 + i % 2, y + 4), (20 + i % 2, y + 4)], c)
        d.line([(22 + i % 2, y + 2), (38 + i % 2, y + 2)], fill='#ffffff')
    d.line([(56, 28), (56, 8)], fill=outline, width=3); d.line([(56, 8), (64, 4)], fill=outline, width=3)
    poly([(60, 2), (70, 2), (72, 8), (58, 8)], '#ffd591')                              # desk lamp
    d.ellipse((60, 8, 70, 12), fill='#fff3c4')
    poly([(50, 26), (54, 26), (54, 31), (50, 31)], '#f0e6d8')                          # ink pot
    return im, anchor

manifest['props'] = {}
for name, fn in (('hotdesk', hotdesk), ('easel', easel), ('board', board), ('bookdesk', bookdesk)):
    img, anchor = fn()
    img.save(root/'atlases'/f'{name}.png')
    manifest['props'][name] = {'image': f'atlases/{name}.png', 'anchor': anchor, 'size': list(img.size)}
# Which character and prop each lane kind uses at a hot desk (office.html reads this).
manifest['kinds'] = {
    'code':   {'rolePrefix': 'hot',       'prop': 'hotdesk',  'label': 'Coder'},
    'art':    {'rolePrefix': 'painter',   'prop': 'easel',    'label': 'Painter'},
    'review': {'rolePrefix': 'inspector', 'prop': 'board',    'label': 'Inspector'},
    'docs':   {'rolePrefix': 'writer',    'prop': 'bookdesk', 'label': 'Writer'},
}
(root/'sprites.json').write_text(json.dumps(manifest,indent=2)+'\n')
