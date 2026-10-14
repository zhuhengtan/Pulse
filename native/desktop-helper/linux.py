#!/usr/bin/env python3
"""X11 and portal desktop backend. All input is typed JSON; no shell execution.

Runtime packages: python3-gi, python3-dbus, gir1.2-atspi-2.0,
gir1.2-gtk-3.0, gir1.2-gstreamer-1.0, gstreamer1.0-pipewire,
gstreamer1.0-plugins-good, libxtst6. Wayland needs RemoteDesktop/ScreenCast.
"""
import ctypes
import ctypes.util
import json
import os
import select
import sys
import time
import traceback

portal = None
session_path = None
pipeline = None
display = None
stream_id = None
width = height = 0
origin_x = origin_y = 0
elements = {}
held = []
wayland = bool(os.environ.get('WAYLAND_DISPLAY'))
keys = {'Control': 0xffe3, 'Ctrl': 0xffe3, 'Shift': 0xffe1, 'Alt': 0xffe9,
        'Meta': 0xffeb, 'Command': 0xffeb, 'Enter': 0xff0d, 'Return': 0xff0d,
        'Tab': 0xff09, 'Escape': 0xff1b, 'Backspace': 0xff08, 'Delete': 0xffff,
        'ArrowLeft': 0xff51, 'ArrowUp': 0xff52, 'ArrowRight': 0xff53,
        'ArrowDown': 0xff54, 'Home': 0xff50, 'End': 0xff57,
        'PageUp': 0xff55, 'PageDown': 0xff56, 'Space': 0x20}


def init_libraries():
    global GLib, Gst, Gdk, Atspi, dbus, bus
    import gi
    gi.require_version('Gst', '1.0')
    gi.require_version('Gdk', '3.0')
    gi.require_version('Atspi', '2.0')
    from gi.repository import GLib, Gst, Gdk, Atspi
    import dbus
    from dbus.mainloop.glib import DBusGMainLoop
    DBusGMainLoop(set_as_default=True)
    bus = dbus.SessionBus()
    Gst.init(None)


def portal_request(method, *args):
    result = {}
    loop = GLib.MainLoop()
    path = str(method(*args))
    def response(code, values):
        result.update(code=int(code), values=values)
        loop.quit()
    receiver = bus.add_signal_receiver(response, 'Response', 'org.freedesktop.portal.Request', path=path)
    timeout = GLib.timeout_add_seconds(60, lambda: (loop.quit(), False)[1])
    poller = select.poll()
    poller.register(sys.stdin.fileno(), select.POLLHUP)
    def disconnected():
        if poller.poll(0):
            result['code'] = -1
            loop.quit()
            return False
        return True
    disconnect_timer = GLib.timeout_add(100, disconnected)
    try:
        loop.run()
    finally:
        receiver.remove()
        GLib.source_remove(timeout)
        GLib.source_remove(disconnect_timer)
        if result.get('code') != 0:
            try: dbus.Interface(bus.get_object('org.freedesktop.portal.Desktop', path), 'org.freedesktop.portal.Request').Close()
            except Exception: pass
    if result.get('code') != 0:
        raise RuntimeError('PORTAL_PERMISSION_DENIED_OR_TIMEOUT')
    return result['values']


def start():
    global portal, session_path, pipeline, display, stream_id, width, height, x11, xtst, root
    if display is not None or session_path:
        return
    init_libraries()
    if wayland:
        proxy = bus.get_object('org.freedesktop.portal.Desktop', '/org/freedesktop/portal/desktop')
        portal = dbus.Interface(proxy, 'org.freedesktop.portal.RemoteDesktop')
        cast = dbus.Interface(proxy, 'org.freedesktop.portal.ScreenCast')
        created = portal_request(portal.CreateSession, {'session_handle_token': 'pulse_' + str(os.getpid())})
        session_path = created['session_handle']
        portal_request(portal.SelectDevices, session_path, {'types': dbus.UInt32(3)})
        portal_request(cast.SelectSources, session_path, {'types': dbus.UInt32(1), 'multiple': False, 'cursor_mode': dbus.UInt32(2)})
        selected = portal_request(portal.Start, session_path, '', {})
        streams = selected.get('streams', [])
        if not streams:
            raise RuntimeError('PORTAL_SCREENCAST_UNAVAILABLE')
        stream_id, info = streams[0]
        width, height = map(int, info.get('size', (0, 0)))
        if not width or not height:
            raise RuntimeError('PORTAL_DISPLAY_SIZE_UNAVAILABLE')
        descriptor = cast.OpenPipeWireRemote(session_path, {}).take()
        scale = min(1, 1600 / max(width, height))
        pipeline = Gst.parse_launch('pipewiresrc fd=%d path=%d do-timestamp=true ! videoconvert ! videoscale ! video/x-raw,width=%d,height=%d ! jpegenc quality=75 ! appsink name=sink max-buffers=1 drop=true sync=false' % (descriptor, stream_id, int(width*scale), int(height*scale)))
        pipeline.set_state(Gst.State.PLAYING)
    else:
        x11 = ctypes.CDLL(ctypes.util.find_library('X11'))
        xtst = ctypes.CDLL(ctypes.util.find_library('Xtst'))
        x11.XOpenDisplay.restype = ctypes.c_void_p
        x11.XDefaultRootWindow.argtypes = [ctypes.c_void_p]
        x11.XDefaultRootWindow.restype = ctypes.c_ulong
        x11.XDisplayWidth.argtypes = x11.XDisplayHeight.argtypes = [ctypes.c_void_p, ctypes.c_int]
        x11.XKeysymToKeycode.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
        x11.XKeysymToKeycode.restype = ctypes.c_uint
        x11.XFlush.argtypes = [ctypes.c_void_p]
        xtst.XTestFakeKeyEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]
        xtst.XTestFakeButtonEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]
        xtst.XTestFakeMotionEvent.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_ulong]
        display = x11.XOpenDisplay(None)
        if not display:
            raise RuntimeError('X11_DISPLAY_UNAVAILABLE')
        root = x11.XDefaultRootWindow(display)
        width, height = x11.XDisplayWidth(display, 0), x11.XDisplayHeight(display, 0)


def geometry():
    return '%s:%s:%s:%s' % ('wayland' if wayland else 'x11', stream_id or 0, width, height)


def key(symbol, down):
    if wayland:
        portal.NotifyKeyboardKeysym(session_path, {}, dbus.Int32(symbol), dbus.UInt32(1 if down else 0))
    else:
        code = x11.XKeysymToKeycode(display, symbol)
        if not code:
            raise RuntimeError('UNSUPPORTED_KEY')
        xtst.XTestFakeKeyEvent(display, code, bool(down), 0); x11.XFlush(display)


def button(number, down):
    if wayland:
        portal.NotifyPointerButton(session_path, {}, dbus.Int32({1:272, 2:274, 3:273}[number]), dbus.UInt32(1 if down else 0))
    else:
        xtst.XTestFakeButtonEvent(display, number, bool(down), 0); x11.XFlush(display)


def move(point):
    if not all(isinstance(point.get(k), (float, int)) and 0 <= point[k] <= 1 for k in ('x', 'y')):
        raise RuntimeError('INVALID_POINT')
    x, y = point['x'] * (width-1), point['y'] * (height-1)
    if wayland:
        portal.NotifyPointerMotionAbsolute(session_path, {}, dbus.UInt32(stream_id), dbus.Double(x), dbus.Double(y))
    else:
        xtst.XTestFakeMotionEvent(display, 0, int(x+origin_x), int(y+origin_y), 0); x11.XFlush(display)


def release():
    for symbol in reversed(held):
        try: key(symbol, False)
        except Exception: pass
    held.clear()
    if display is not None or session_path:
        for number in (1, 3):
            try: button(number, False)
            except Exception: pass


def tree():
    elements.clear()
    lines = []
    def walk(element, depth):
        if depth > 8 or len(elements) >= 250:
            return
        try:
            ref = 'e%d' % len(elements); elements[ref] = element
            lines.append('[%s] %s %s' % (ref, element.get_role_name(), element.get_name()[:120]))
            for i in range(min(element.get_child_count(), 250)):
                walk(element.get_child_at_index(i), depth+1)
        except Exception: pass
    walk(Atspi.get_desktop(0), 0)
    return '\n'.join(lines)


def observe():
    import base64
    start()
    scale = min(1, 1600/max(width,height))
    if wayland:
        sample = pipeline.get_by_name('sink').emit('try-pull-sample', 5 * Gst.SECOND)
        if not sample:
            raise RuntimeError('PIPEWIRE_CAPTURE_TIMEOUT')
        buffer = sample.get_buffer()
        data = buffer.extract_dup(0, buffer.get_size())
    else:
        window = Gdk.get_default_root_window()
        pixbuf = Gdk.pixbuf_get_from_window(window, origin_x, origin_y, width, height)
        if not pixbuf:
            raise RuntimeError('X11_CAPTURE_UNAVAILABLE')
        from gi.repository import GdkPixbuf
        small = pixbuf.scale_simple(int(width*scale), int(height*scale), GdkPixbuf.InterpType.BILINEAR)
        ok, data = small.save_to_bufferv('jpeg', ['quality'], ['75'])
        if not ok:
            raise RuntimeError('SCREENSHOT_ENCODING_FAILED')
    return {'width':int(width*scale),'height':int(height*scale),'geometry':geometry(),'text':tree(),'image':{'mediaType':'image/jpeg','data':base64.b64encode(data).decode('ascii')}}


def act(action):
    kind = action['type']
    try:
        if kind == 'click':
            move(action['point'])
            number = 3 if action.get('button') == 'right' else 1
            for _ in range(action.get('count',1)): button(number, True); button(number, False)
        elif kind == 'drag':
            move(action['from']); button(1, True)
            for i in range(1,21):
                move({k:action['from'][k]+(action['to'][k]-action['from'][k])*i/20 for k in ('x','y')}); time.sleep(.01)
            button(1, False)
        elif kind == 'scroll':
            move(action['point'])
            if wayland:
                portal.NotifyPointerAxis(session_path, {}, dbus.Double(action.get('dx',0)), dbus.Double(action.get('dy',0)))
            else:
                for delta,positive,negative in [(action.get('dy',0),5,4),(action.get('dx',0),7,6)]:
                    for _ in range(min(30,abs(int(delta))//40+1) if delta else 0): button(positive if delta > 0 else negative,True);button(positive if delta > 0 else negative,False)
        elif kind == 'key':
            for name in action['keys']:
                symbol = keys.get(name, ord(name) if len(name)==1 else 0)
                if not symbol: raise RuntimeError('UNSUPPORTED_KEY')
                held.append(symbol); key(symbol,True)
        elif kind == 'element':
            element=elements.get(action['ref'])
            if not element: raise RuntimeError('STALE_ELEMENT')
            if action['operation']=='click':
                if not element.get_action_iface().do_action(0): raise RuntimeError('ELEMENT_OPERATION_UNSUPPORTED')
            elif action['operation']=='fill':
                if not element.get_editable_text_iface().set_text_contents(action.get('value','')): raise RuntimeError('ELEMENT_OPERATION_UNSUPPORTED')
            else: raise RuntimeError('ELEMENT_OPERATION_UNSUPPORTED')
        elif kind == 'type':
            focused = next((e for e in elements.values() if e.get_state_set().contains(Atspi.StateType.FOCUSED)), None)
            if focused and focused.get_editable_text_iface():
                editable=focused.get_editable_text_iface();offset=focused.get_text_iface().get_caret_offset()
                if not editable.insert_text(offset,action['text'],len(action['text'].encode('utf8'))): raise RuntimeError('TEXT_INPUT_FAILED')
            elif wayland:
                for char in action['text']:
                    symbol=ord(char) if ord(char)<256 else 0x01000000|ord(char)
                    key(symbol,True);key(symbol,False)
            else:
                for char in action['text']:
                    symbol=ord(char) if ord(char)<256 else 0x01000000|ord(char)
                    key(symbol,True);key(symbol,False)
        else: raise RuntimeError('UNSUPPORTED_ACTION')
    finally: release()
    elements.clear()
    return {'applied':True}


def call(method, params):
    if method in ('doctor','hello'):
        init_libraries()
        return {'protocolVersion':1,'platform':'linux','session':'wayland' if wayland else 'x11','requiresPortalConsent':wayland,'screenCapture':bool(os.environ.get('DISPLAY') or os.environ.get('WAYLAND_DISPLAY'))}
    if method=='release': release();return {'released':True}
    if method=='observe':
        start()
        if not wayland and params.get('displayId') is not None:
            index=int(params['displayId']);gd=Gdk.Display.get_default()
            if index<0 or index>=gd.get_n_monitors(): raise RuntimeError('DISPLAY_NOT_AVAILABLE')
            bounds=gd.get_monitor(index).get_geometry();globals().update(origin_x=bounds.x,origin_y=bounds.y,width=bounds.width,height=bounds.height)
        return observe()
    start()
    global width, height, origin_x, origin_y
    if not wayland and params.get('displayId') is not None:
        index = int(params['displayId'])
        gdisplay = Gdk.Display.get_default()
        if index < 0 or index >= gdisplay.get_n_monitors(): raise RuntimeError('DISPLAY_NOT_AVAILABLE')
        bounds = gdisplay.get_monitor(index).get_geometry()
        origin_x, origin_y, width, height = bounds.x, bounds.y, bounds.width, bounds.height
    if method=='displays' and not wayland:
        gdisplay = Gdk.Display.get_default()
        return [{'id':str(i),'x':gdisplay.get_monitor(i).get_geometry().x,'y':gdisplay.get_monitor(i).get_geometry().y,'width':gdisplay.get_monitor(i).get_geometry().width,'height':gdisplay.get_monitor(i).get_geometry().height} for i in range(gdisplay.get_n_monitors())]
    if method=='displays': return [{'id':str(stream_id or 0),'width':width,'height':height}]
    if method=='windows':
        tree()
        return [{'id':ref,'title':e.get_name()} for ref,e in elements.items() if e.get_role() in (Atspi.Role.FRAME,Atspi.Role.WINDOW,Atspi.Role.DIALOG)]
    if method=='selectWindow':
        element=elements.get(params.get('windowId'))
        if not element or not element.get_component_iface().grab_focus(): raise RuntimeError('WINDOW_FOCUS_UNSUPPORTED')
        return {'selected':True}
    if method=='act':
        if params.get('geometry')!=geometry(): raise RuntimeError('STALE_GEOMETRY')
        return act(params['action'])
    raise RuntimeError('UNKNOWN_METHOD')


try:
    for line in sys.stdin:
        request = {}
        try:
            if len(line)>65536: raise RuntimeError('REQUEST_TOO_LARGE')
            request=json.loads(line)
            result=call(request['method'],request.get('params',{}))
            response={'jsonrpc':'2.0','id':request.get('id'),'result':result}
        except Exception as error:
            release()
            response={'jsonrpc':'2.0','id':request.get('id'),'error':{'message':str(error)}}
        print(json.dumps(response,ensure_ascii=False),flush=True)
finally:
    release()
    if pipeline: pipeline.set_state(Gst.State.NULL)
    if session_path:
        try: dbus.Interface(bus.get_object('org.freedesktop.portal.Desktop',session_path),'org.freedesktop.portal.Session').Close()
        except Exception: pass
