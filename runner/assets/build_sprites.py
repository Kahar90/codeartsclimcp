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
}
sequences = {
    'idle': [1800, 85, 115, 2300],
    'work': [125, 95, 90, 120, 100, 95, 110, 270],
    'receive': [85, 90, 100, 135, 170],
    'complete': [100, 85, 95, 115, 150, 170],
    'blocked': [250, 1500],
}
cell, stride, columns = 64, 66, 8

def sprite(role, clip, frame):
    im = Image.new('RGBA', (cell, cell))
    d = ImageDraw.Draw(im)
    color, dark, light = roles[role]
    blink = clip == 'idle' and frame == 1
    lift = [0, 1, 2, 3, 2, 1][frame] if clip == 'complete' else 0
    motion = [0,1,2,3,2,1,0,0][frame] if clip == 'work' else [0,2,4,2,0][frame] if clip == 'receive' else lift
    y = -lift if role != 'builder' else 0

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

    if role == 'builder':
        line([(30,13),(30,7),(34,7)],outline,3)
        box((33,4,37,8),light,outline)
        poly([(19,14),(36,11),(44,15),(47,20),(46,31),(41,36),(23,37),(15,32),(14,22)], '#91b3c5')
        poly([(21,14),(36,13),(43,17),(44,27),(38,33),(23,33),(18,28),(18,21)],'#e2f1e9')
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
        if role == 'artist':
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
        elif role == 'lead':
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
(root/'sprites.json').write_text(json.dumps(manifest,indent=2)+'\n')
