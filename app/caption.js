/*
 * Optional add-on: say in the bar why the app opened, from Frigate.
 *
 *   "Car, Person, Renata, Zoran detected"
 *
 * Whatever launched the app (a Home Assistant automation, usually) still decides
 * when it opens; this only names the reason. The launch itself cannot carry the
 * text: measured on a 2020 The Frame, ed.apps.launch - the only launch with a
 * metaTag - does not start a sideloaded widget at all, with or without one. So
 * the app asks Frigate for the newest review on its cameras instead.
 *
 * {label} is built the way the SgtBatten Frigate notification blueprint builds
 * its own with update_sub_label on (its default): objects without Frigate's
 * "-verified" twins, plus the sub labels (recognised faces, plates),
 * de-duplicated and sorted ignoring case, title-cased, comma-joined. The TV then
 * says what the phone says. The blueprint's `labels` filter and `label_names`
 * renames are not applied.
 *
 * main.js only calls PipCaption.start() on every launch and reads
 * PipCaption.text() for the bar. Without this file loaded, nothing changes.
 *
 * Config, all in config.yaml:
 *
 *   cameras:
 *     - name: "Front yard"
 *       frigateCamera: front_yard_camera   # the camera's name in Frigate
 *   frigateUrl: "http://frigate-host:5000" # unauthenticated port; null = off
 *   captionFormat: "{label} detected"      # {label}, {time} (HH:MM), {camera}
 *   captionMaxAgeS: 300        # ignore a review that started longer ago
 *   captionSubLabels: true     # false leaves the sub labels out
 *   captionRefreshMs: 5000     # ask again while open; a face is often
 *                              # recognised seconds after the review starts
 */
(function () {

var DEFAULTS = {
    frigateUrl: null,
    captionFormat: '{label} detected at {time}',
    captionMaxAgeS: 300,
    captionSubLabels: true,
    captionRefreshMs: 5000
};

var state = { text: '', gen: 0, timer: null, cfg: null, onChange: null, log: null };

function setting(key) {
    var v = state.cfg[key];
    return (v === undefined) ? DEFAULTS[key] : v;
}

function pad(n) { return n < 10 ? '0' + n : '' + n; }

function frigateCameras() {
    var cams = state.cfg.cameras || [], out = [];
    for (var i = 0; i < cams.length; i++) {
        if (cams[i].frigateCamera) { out.push(cams[i].frigateCamera); }
    }
    return out;
}

function cameraNameFor(frigateName) {
    var cams = state.cfg.cameras || [];
    for (var i = 0; i < cams.length; i++) {
        if (cams[i].frigateCamera === frigateName) { return cams[i].name || frigateName; }
    }
    return frigateName;
}

// Jinja's `title`: each word capitalised, the rest lowercased. Copied so the
// text matches what a Home Assistant template makes of the same review.
function jinjaTitle(s) {
    var parts = String(s).split(/([-\s({\[<]+)/);
    var out = '';
    for (var i = 0; i < parts.length; i++) {
        if (parts[i]) { out += parts[i].charAt(0).toUpperCase() + parts[i].slice(1).toLowerCase(); }
    }
    return out;
}

function captionLabel(review) {
    var data = review.data || {};
    var all = [], seen = {}, i;
    var objects = data.objects || [];
    for (i = 0; i < objects.length; i++) {
        if (String(objects[i]).indexOf('-verified') === -1) { all.push(String(objects[i])); }
    }
    if (setting('captionSubLabels') !== false) {
        var subs = data.sub_labels || [];
        for (i = 0; i < subs.length; i++) {
            // Older Frigate sends [name, score] pairs.
            all.push(String(subs[i] && subs[i].push ? subs[i][0] : subs[i]));
        }
    }
    var unique = [];
    for (i = 0; i < all.length; i++) {
        var key = all[i].toLowerCase();
        if (!seen[key]) { seen[key] = true; unique.push(all[i]); }
    }
    unique.sort(function (a, b) {
        a = a.toLowerCase(); b = b.toLowerCase();
        return a < b ? -1 : (a > b ? 1 : 0);
    });
    for (i = 0; i < unique.length; i++) { unique[i] = jinjaTitle(unique[i]); }
    return unique.join(', ');
}

function formatCaption(review) {
    var d = new Date(review.start_time * 1000);
    var vars = {
        label: captionLabel(review) || 'Activity',
        time: pad(d.getHours()) + ':' + pad(d.getMinutes()),
        camera: cameraNameFor(review.camera)
    };
    return String(setting('captionFormat')).replace(/\{(label|time|camera)\}/g,
        function (m, key) { return vars[key]; });
}

function askFrigate(gen) {
    if (gen !== state.gen) { return; }
    var url = String(setting('frigateUrl')).replace(/\/+$/, '') +
              '/api/review?limit=1&cameras=' + encodeURIComponent(frigateCameras().join(','));
    var xhr = new XMLHttpRequest();
    function release() {
        try { if (xhr.destroy) { xhr.destroy(); } } catch (e) { /* not fatal */ }
    }
    try {
        xhr.open('GET', url, true);
        xhr.timeout = 3000;
        xhr.onreadystatechange = function () {
            if (xhr.readyState !== 4) { return; }
            // A relaunch has asked again since; this answer is for the old run.
            if (gen === state.gen && xhr.status === 200) {
                try {
                    var r = JSON.parse(xhr.responseText)[0];
                    var ageS = new Date().getTime() / 1000 - (r ? r.start_time : 0);
                    // Keep what is shown when the newest review ages out mid-run.
                    if (r && ageS <= setting('captionMaxAgeS')) {
                        var text = formatCaption(r);
                        if (text !== state.text) {
                            state.text = text;
                            state.log('caption: ' + text);
                            state.onChange();
                        }
                    }
                } catch (e) { state.log('caption: unreadable answer from Frigate'); }
            }
            release();
        };
        xhr.ontimeout = xhr.onerror = release;
        xhr.send();
    } catch (e) {
        state.log('caption: request threw ' + e.name);
    }
}

window.PipCaption = {
    // Called on every launch, including a relaunch while on screen.
    start: function (cfg, onChange, log) {
        if (state.timer !== null) { clearInterval(state.timer); state.timer = null; }
        state.cfg = cfg || {};
        state.onChange = onChange || function () {};
        state.log = log || function () {};
        state.text = '';
        var gen = ++state.gen;
        if (!setting('frigateUrl') || !frigateCameras().length) { return; }
        askFrigate(gen);
        var every = setting('captionRefreshMs');
        if (every > 0) {
            state.timer = setInterval(function () { askFrigate(gen); }, every);
        }
    },
    text: function () { return state.text; }
};

}());
