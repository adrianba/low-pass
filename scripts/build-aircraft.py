"""Build the original Kestrel aircraft. Blender coordinates: +Y forward, +Z up."""
import bpy
import math
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "public" / "assets"
OUT.mkdir(parents=True, exist_ok=True)
(ROOT / "art").mkdir(exist_ok=True)
bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete(use_global=False)


def material(name, color, metal=0.0, roughness=0.5):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    node = mat.node_tree.nodes.get("Principled BSDF")
    node.inputs["Base Color"].default_value = (*color, 1)
    node.inputs["Metallic"].default_value = metal
    node.inputs["Roughness"].default_value = roughness
    return mat


skin = material("Titanium grey / painted alloy", (0.33, 0.39, 0.40), 0.52, 0.38)
dark = material("Carbon and intake shadow", (0.025, 0.034, 0.038), 0.3, 0.62)
edge = material("Panel seams", (0.105, 0.135, 0.14), 0.4, 0.48)
nozzle = material("Exhaust alloy", (0.20, 0.19, 0.17), 0.9, 0.30)
glass = material("Smoked canopy", (0.035, 0.095, 0.13), 0.72, 0.10)
accent = material("Rescue orange", (0.91, 0.25, 0.055), 0.1, 0.4)
bomb_skin = material("Practice bomb olive", (0.17, 0.20, 0.105), 0.5, 0.55)


def mesh(name, vertices, faces, mat):
    data = bpy.data.meshes.new(name)
    data.from_pydata(vertices, [], faces)
    data.update()
    obj = bpy.data.objects.new(name, data)
    bpy.context.collection.objects.link(obj)
    obj.data.materials.append(mat)
    bevel = obj.modifiers.new("Soft manufactured edges", "BEVEL")
    bevel.width = 0.045
    bevel.segments = 2
    obj.modifiers.new("Weighted surface normals", "WEIGHTED_NORMAL")
    return obj


def hull(name, sections, mat, steps=48):
    vertices = []
    for y, width, height, center in sections:
        for i in range(steps):
            a = 2 * math.pi * i / steps
            vertices.append((math.cos(a) * width, y, center + math.sin(a) * height))
    faces = []
    for j in range(len(sections) - 1):
        for i in range(steps):
            n = (i + 1) % steps
            faces.append((j * steps + i, j * steps + n, (j + 1) * steps + n, (j + 1) * steps + i))
    faces.extend([tuple(reversed(range(steps))), tuple((len(sections) - 1) * steps + i for i in range(steps))])
    obj = mesh(name, vertices, faces, mat)
    for poly in obj.data.polygons:
        poly.use_smooth = True
    return obj


def plate(name, polygon, thickness, mat):
    count = len(polygon)
    vertices = [(x, y, z - thickness / 2) for x, y, z in polygon]
    vertices += [(x, y, z + thickness / 2) for x, y, z in polygon]
    faces = [tuple(reversed(range(count))), tuple(range(count, count * 2))]
    faces += [(i, (i + 1) % count, (i + 1) % count + count, i + count) for i in range(count)]
    return mesh(name, vertices, faces, mat)


def line(name, points, radius, mat):
    curve = bpy.data.curves.new(name, "CURVE")
    curve.dimensions = "3D"
    curve.bevel_depth = radius
    curve.bevel_resolution = 2
    spline = curve.splines.new("POLY")
    spline.points.add(len(points) - 1)
    for p, co in zip(spline.points, points):
        p.co = (*co, 1)
    obj = bpy.data.objects.new(name, curve)
    bpy.context.collection.objects.link(obj)
    obj.data.materials.append(mat)
    return obj


hull("Kestrel / fuselage", [
    (-8, .65, .65, .05), (-6.5, .85, .78, .07), (-4.2, 1.05, .87, .06),
    (-1.5, 1.08, .93, .05), (1, .97, .88, .05), (3.5, .73, .70, .04),
    (5.8, .51, .49, .02), (7.5, .31, .31, 0), (9.4, .025, .025, -.04),
], skin)
hull("Radome", [(5.6, .525, .50, .02), (7.4, .33, .33, 0), (9.4, .025, .025, -.04)], edge)
hull("Intake housing", [(-2.5, .67, .3, -.73), (0, .72, .42, -.78), (2.5, .59, .45, -.8), (3.0, .51, .38, -.76)], skin)
hull("Intake mouth", [(3.01, .47, .34, -.76), (3.04, .47, .34, -.76)], dark)
hull("Bubble canopy", [(.6, .30, .12, .91), (1.3, .57, .53, .88), (2.7, .57, .72, .75),
                      (4.0, .39, .48, .68), (4.6, .06, .06, .61)], glass)
for side in [-1, 1]:
    line("Canopy frame", [(side * .3, .6, .94), (side * .57, 1.3, .89), (side * .57, 2.7, .77),
                         (side * .39, 4, .69), (side * .06, 4.6, .64)], .035, skin)
    plate("Swept wing", [(side * .7, 1.7, -.05), (side * 5.8, -2.8, -.14),
                        (side * 5.85, -4.3, -.21), (side * 1, -3.8, -.12)], .17, skin)
    plate("Wing root extension", [(side * .7, 4.5, -.03), (side * 2.4, -.1, -.03),
                                 (side * 1.8, -1.8, -.02)], .12, skin)
    plate("Tailplane", [(side * .75, -4.9, .1), (side * 3.3, -6.3, -.02),
                       (side * 3.5, -8.1, -.08), (side * .7, -7.3, .05)], .13, skin)
    line("Wing control surface", [(side * 1.4, -3.13, .006), (side * 5.5, -3.72, -.078)], .022, edge)
    line("Wing spar seam", [(side * 1.4, -.2, .07), (side * 4.4, -2.15, -.045)], .018, edge)
    hull("Wingtip rail", [(-4.9, .07, .07, 0), (-1.95, .07, .07, 0)], edge, 16).location.x = side * 5.83
    plate("Identification flash", [(side * 4.7, -2.75, -.026), (side * 5.25, -3.11, -.04),
                                   (side * 5.28, -3.47, -.062), (side * 4.73, -3.2, -.043)], .022, accent)
    plate("Pylon", [(side * 2.3, -1.2, -.23), (side * 2.3, -3.2, -.23),
                    (side * 2.3, -3.0, -.76), (side * 2.3, -1.4, -.76)], .18, edge)

mesh("Vertical stabilizer", [
    (-.09, -3.7, .64), (-.09, -5.65, 4.0), (-.09, -7.4, 4.0), (-.09, -7.4, .54),
    (.09, -3.7, .64), (.09, -5.65, 4.0), (.09, -7.4, 4.0), (.09, -7.4, .54),
], [(0, 1, 2, 3), (7, 6, 5, 4), (0, 4, 5, 1), (1, 5, 6, 2), (2, 6, 7, 3), (3, 7, 4, 0)], skin)
for side in [-1, 1]:
    line("Tail stripe", [(side * .14, -5.6, 3.5), (side * .14, -7.28, 3.5)], .07, accent)
    line("Rudder seam", [(side * .13, -6.83, 3.9), (side * .13, -6.9, .8)], .018, edge)
hull("Exhaust petals", [(-8.6, .59, .59, .05), (-8.05, .67, .67, .05), (-7.6, .70, .70, .05)], nozzle, 32)
hull("Exhaust opening", [(-8.62, .51, .51, .05), (-8.64, .51, .51, .05)], dark, 32)
for i in range(16):
    a = i * 2 * math.pi / 16
    line("Nozzle segment", [(math.cos(a) * .6, -8.61, .05 + math.sin(a) * .6),
                           (math.cos(a) * .705, -7.65, .05 + math.sin(a) * .705)], .018, edge)

mount = bpy.data.objects.new("release_mount", None)
bpy.context.collection.objects.link(mount)
mount.location = (0, 0, -2.2)

# Collapse by material after applying edge treatment, keeping one draw per material.
for obj in list(bpy.context.scene.objects):
    if obj.type == "CURVE":
        bpy.ops.object.select_all(action="DESELECT")
        obj.select_set(True)
        bpy.context.view_layer.objects.active = obj
        bpy.ops.object.convert(target="MESH")
    if obj.type == "MESH":
        bpy.context.view_layer.objects.active = obj
        for modifier in list(obj.modifiers):
            bpy.ops.object.modifier_apply(modifier=modifier.name)
for mat in [skin, dark, edge, nozzle, glass, accent]:
    objects = [o for o in bpy.context.scene.objects if o.type == "MESH" and o.data.materials[0] == mat]
    if objects:
        bpy.ops.object.select_all(action="DESELECT")
        for obj in objects:
            obj.select_set(True)
        bpy.context.view_layer.objects.active = objects[0]
        if len(objects) > 1:
            bpy.ops.object.join()
        objects[0].name = mat.name

# Do not embed local file-browser directories in the editable asset.
for screen in bpy.data.screens:
    for area in screen.areas:
        for space in area.spaces:
            if space.type == "FILE_BROWSER" and space.params:
                space.params.directory = b"//"
bpy.ops.wm.save_as_mainfile(filepath=str(ROOT / "art" / "kestrel.blend"))
bpy.ops.export_scene.gltf(filepath=str(OUT / "kestrel.glb"), export_format="GLB", export_yup=True)

bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete(use_global=False)
hull("Practice bomb", [(-1.5, .14, .14, 0), (-.8, .24, .24, 0), (.5, .25, .25, 0),
                       (1.0, .18, .18, 0), (1.3, .015, .015, 0)], bomb_skin, 24)
for i in range(4):
    angle = i * math.pi / 2
    plate("Tail fin", [(0, -1.4, 0), (math.cos(angle) * .5, -1.4, math.sin(angle) * .5),
                      (math.cos(angle) * .5, -.65, math.sin(angle) * .5), (0, -.45, 0)], .045, edge)
bpy.ops.export_scene.gltf(filepath=str(OUT / "practice-bomb.glb"), export_format="GLB", export_yup=True)
print("Original aircraft and bomb exported to", OUT)
