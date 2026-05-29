// utils.js
const $ = id => document.getElementById(id);
const on = (id, evt, cb) => { const e = $(id); if(e) e.addEventListener(evt, cb); };
const cmd = args => cockpit.spawn(args, { superuser: "require" });
const parseSize = s => { const m = s.match(/([0-9.]+)\s*([a-zA-Z]+)/); return m ? parseFloat(m[1]) * ({"K":1024,"M":1048576,"G":1073741824,"T":1099511627776}[m[2][0].toUpperCase()]||1) : 0; };
const formatSize = b => (b===0||isNaN(b)) ? "0 B" : (b/Math.pow(1024, Math.floor(Math.log(b)/Math.log(1024)))).toFixed(2) + " " + ["B","KiB","MiB","GiB","TiB"][Math.floor(Math.log(b)/Math.log(1024))];

const Modal = {
    cb: null,
    show(title, msg, type = "alert", opts = null, cb = null) {
        try {
            $("generic-modal-title").innerText = title;
            $("generic-modal-message").innerText = msg;
            $("generic-modal-input-container").classList.toggle("hidden-element", type === "alert" || type === "confirm");
            $("generic-modal-input").classList.toggle("hidden-element", type !== "prompt");
            $("generic-modal-select").classList.toggle("hidden-element", type !== "select");
            
            if (type === "prompt") { $("generic-modal-input").value = opts || ""; setTimeout(() => $("generic-modal-input").focus(), 100); }
            if (type === "select") { $("generic-modal-select").innerHTML = opts.map(o => `<option value="${o.v}">${o.l}</option>`).join(""); }
            
            this.cb = cb;
            $("generic-modal").classList.remove("hidden-element");
        } catch (e) { console.error("Modal Error:", e); }
    },
    close() { if($("generic-modal")) $("generic-modal").classList.add("hidden-element"); this.cb = null; },
    confirm() { 
        const actionCallback = this.cb; 
        this.close(); 
        if(actionCallback) actionCallback(!$("generic-modal-select").classList.contains("hidden-element") ? $("generic-modal-select").value : $("generic-modal-input").value); 
    }
};

function customAlert(title, message) { Modal.show(title, message, "alert", null, null); }
function customConfirm(title, message, confirmBtnText, onConfirm) { Modal.show(title, message, "confirm", null, onConfirm); }
function customPrompt(title, message, defaultVal, confirmBtnText, onConfirm) { Modal.show(title, message, "prompt", defaultVal, onConfirm); }
function customSelect(title, message, options, confirmBtnText, onConfirm) { Modal.show(title, message, "select", options, onConfirm); }