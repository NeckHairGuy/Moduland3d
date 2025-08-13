let THREE;
let ipcRenderer;

try {
  THREE = require('three');
  ipcRenderer = require('electron').ipcRenderer;
} catch (error) {
  console.error('Failed to load dependencies:', error);
}

let scene, camera, renderer, controls;
let raycaster, mouse;
let groundGrid = [];
let voxels = [];
let selectedVoxels = [];
let savedStructures = [];
let currentTool = 'select';
let gridSizeX = 20;
let gridSizeZ = 20;
let voxelSize = 1;
// Real-world meter length represented by one voxel segment. Adjust as desired.
const METERS_PER_SEGMENT = 4;
// Default isometric camera angles used throughout renderer
const DEFAULT_ISO_ELEVATION_DEG = 35.264; // arctan(sin45)
const DEFAULT_ISO_AZIMUTH_DEG = 45;
let gizmoGroup;
let activeGizmo = null;
let isDraggingGizmo = false;
let currentZoom = 1;
let dragStartPos = null;
let previewGroup;
let dragAxis = null;
let dragDirection = 1;
let shiftPressed = false;
let heightLimit = 20;
let focusMode = false;
let focusedStructure = null;
let focusedStructureVoxels = new Set();
let buildingInstanceGroup = null;
let originalStructureSnapshot = null;
let renderBuildingEnabled = false;
let __envLoaded = false;
let tripoModelGroup = null; // Currently active model for transform controls
let tripoPlacementEnabled = false;
let cachedTripoGLB = null; // store loaded gltf.scene for reuse
let tripoTransformControls = null;
// Track all placed models by structure ID
let placedModelsByStructure = new Map(); // structureId -> { group: THREE.Group, glbUrl: string }
// Screen-space skins per structure
let structureIdToSkinUrls = new Map(); // id -> array of skin image URLs
let activeSkinIndex = new Map(); // id -> current index
let structureGalleries = new Map(); // id -> array of gallery items HTML
let latestCapturedImageUrl = null; // Store the latest captured image for Send to Flux
let skinOverlayMesh = null; // current skin overlay mesh in scene
let skinEls = new Map(); // id -> wrapper div element
let skinAdjustActive = false;
let adjustingStructureId = null;
let skinStates = new Map(); // id -> {x,y,scale}
let lastPointer = null;
let lastFalSeed = null;
// Persistence
const PERSIST_KEY = 'moduland_persist_state_v2';
const PERSIST_ENABLED_KEY = 'moduland_persist_enabled';

let foundationGroup = null; // temporary base shown in focus/capture
let showFoundation = false;
let treeMarkerGroup = null; // persistent tree when foundation toggle is on
let originMarker = null; // marker for scene (0,0,0)

// --- Simple transform panel ---
let transformPanel = null;
let transformPanelObject = null;
let isUpdatingFromPanel = false;

// --- Axis indicator ---
let axisScene, axisCamera, axisRenderer, axisHelper;

function showTransformPanel(object) {
    transformPanelObject = object;
    if (!transformPanel) {
        transformPanel = document.createElement('div');
        transformPanel.id = 'transformPanel';
        transformPanel.style.cssText = `position:fixed;top:120px;left:10px;background:#f6f6f6ee;color:#111;padding:10px 14px;border:1px solid #999;border-radius:4px;font:13px/1.4 sans-serif;z-index:9999;max-width:220px;`;
        transformPanel.innerHTML = `
            <h4 style="margin:0 0 8px 0;font-size:14px;">Transform</h4>
            <div class="field">Pos X <input type="number" step="0.1" id="tx" style="width:60px"></div>
            <div class="field">Pos Y <input type="number" step="0.1" id="ty" style="width:60px"></div>
            <div class="field">Pos Z <input type="number" step="0.1" id="tz" style="width:60px"></div>
            <hr/>
            <div class="field">Rot X° <input type="number" step="1" id="rx" style="width:60px"></div>
            <div class="field">Rot Y° <input type="number" step="1" id="ry" style="width:60px"></div>
            <div class="field">Rot Z° <input type="number" step="1" id="rz" style="width:60px"></div>
            <hr/>
            <div class="field">Scale X <input type="number" step="0.01" id="sx" style="width:60px"></div>
            <div class="field">Scale Y <input type="number" step="0.01" id="sy" style="width:60px"></div>
            <div class="field">Scale Z <input type="number" step="0.01" id="sz" style="width:60px"></div>
            <button id="fitBtn" style="margin-top:8px;padding:4px 8px;">Fit to Structure</button>
            <div style="margin-top:10px;text-align:center;">
                <button id="rotCCW" style="padding:4px 8px;margin:0 5px;">↺ 90°</button>
                <button id="rotCW" style="padding:4px 8px;margin:0 5px;">↻ 90°</button>
            </div>
            <div id="cornerScores" style="margin-top:10px;font-size:11px;background:#333;color:#fff;padding:5px;border-radius:3px;">
                <div><span style="background:#ffff00;color:#000;padding:0 3px;">SW</span>: <span id="swScore">-</span> (target: empty)</div>
                <div>SE: <span id="seScore">-</span></div>
                <div>NW: <span id="nwScore">-</span></div>
                <div>NE: <span id="neScore">-</span></div>
            </div>
        `;
        document.body.appendChild(transformPanel);

        ['tx','ty','tz','rx','ry','rz','sx','sy','sz'].forEach(id => {
            const el = transformPanel.querySelector(`#${id}`);
            el.addEventListener('input', ()=>{
                if (!transformPanelObject) return;
                isUpdatingFromPanel = true;
                const o = transformPanelObject;
                o.position.set(
                    parseFloat(transformPanel.querySelector('#tx').value)||0,
                    parseFloat(transformPanel.querySelector('#ty').value)||0,
                    parseFloat(transformPanel.querySelector('#tz').value)||0
                );
                o.rotation.set(
                    THREE.MathUtils.degToRad(parseFloat(transformPanel.querySelector('#rx').value)||0),
                    THREE.MathUtils.degToRad(parseFloat(transformPanel.querySelector('#ry').value)||0),
                    THREE.MathUtils.degToRad(parseFloat(transformPanel.querySelector('#rz').value)||0)
                );
                const uiScaleX = parseFloat(transformPanel.querySelector('#sx').value)||1;
                const uiScaleY = parseFloat(transformPanel.querySelector('#sy').value)||1;
                const uiScaleZ = parseFloat(transformPanel.querySelector('#sz').value)||1;
                // Convert displayed scale (segment-units) to actual scale (world-units)
                const realScaleX = uiScaleX / METERS_PER_SEGMENT;
                const realScaleY = uiScaleY / METERS_PER_SEGMENT;
                const realScaleZ = uiScaleZ / METERS_PER_SEGMENT;
                o.scale.set(realScaleX, realScaleY, realScaleZ);
                o.updateMatrixWorld();
                isUpdatingFromPanel = false;
                updateCornerScores();
            });
        });
        // Attach Fit button listener once
        const fitBtn = transformPanel.querySelector('#fitBtn');
        fitBtn.addEventListener('click', () => {
            if (!transformPanelObject) return;
            const obj = transformPanelObject;
            
            // Determine which structure to fit against
            const sid = obj.userData?.structureId ?? (focusedStructure && focusedStructure.id);
            if (sid == null) { 
                alert('No target structure to fit against'); 
                return; 
            }
            
            // Use the auto-align function that properly handles missing corner alignment
            autoAlignModelToStructureFoundation(obj, sid);
            updateTransformPanel();
        });
        
        // Attach rotation button listeners
        const rotCCW = transformPanel.querySelector('#rotCCW');
        const rotCW = transformPanel.querySelector('#rotCW');
        
        rotCCW.addEventListener('click', () => {
            if (!transformPanelObject) return;
            transformPanelObject.rotation.y -= Math.PI / 2;
            transformPanelObject.updateMatrixWorld(true);
            updateTransformPanel();
            updateCornerScores();
        });
        
        rotCW.addEventListener('click', () => {
            if (!transformPanelObject) return;
            transformPanelObject.rotation.y += Math.PI / 2;
            transformPanelObject.updateMatrixWorld(true);
            updateTransformPanel();
            updateCornerScores();
        });
    }
    updateTransformPanel();
    
    // Add SW corner highlight
    showSWCornerHighlight();
    
    // Update corner scores
    updateCornerScores();
}

function showSWCornerHighlight() {
    // Remove any existing highlights
    ['swCornerHighlight', 'cornerTestRegions'].forEach(name => {
        const old = scene.getObjectByName(name);
        if (old) scene.remove(old);
    });
    
    // Determine which structure to check against
    const sid = transformPanelObject?.userData?.structureId ?? (focusedStructure && focusedStructure.id);
    if (!sid) return;
    
    const sInfo = computeStructureFoundationInfo(sid);
    if (!sInfo || !transformPanelObject) return;
    
    // Create group for all corner highlights
    const cornerGroup = new THREE.Group();
    cornerGroup.name = 'cornerTestRegions';
    
    // Define 1x1 corner regions one voxel outside the structure diagonally
    const voxelSize = 1.0;
    
    // Each corner is positioned just outside the structure bounds
    const cornerDefs = [
        { name: 'SW', color: 0xffff00, opacity: 0.5, 
          minX: sInfo.rMaxX, maxX: sInfo.rMaxX + voxelSize, 
          minZ: sInfo.rMaxZ, maxZ: sInfo.rMaxZ + voxelSize },
        { name: 'SE', color: 0xff0000, opacity: 0.2,
          minX: sInfo.rMinX - voxelSize, maxX: sInfo.rMinX, 
          minZ: sInfo.rMaxZ, maxZ: sInfo.rMaxZ + voxelSize },
        { name: 'NW', color: 0x00ff00, opacity: 0.2,
          minX: sInfo.rMaxX, maxX: sInfo.rMaxX + voxelSize, 
          minZ: sInfo.rMinZ - voxelSize, maxZ: sInfo.rMinZ },
        { name: 'NE', color: 0x0000ff, opacity: 0.2,
          minX: sInfo.rMinX - voxelSize, maxX: sInfo.rMinX, 
          minZ: sInfo.rMinZ - voxelSize, maxZ: sInfo.rMinZ }
    ];
    
    // Create visual boxes for each corner region
    cornerDefs.forEach(corner => {
        const width = corner.maxX - corner.minX;
        const depth = corner.maxZ - corner.minZ;
        const height = 0.2;
        
        const box = new THREE.Mesh(
            new THREE.BoxGeometry(width, height, depth),
            new THREE.MeshBasicMaterial({ 
                color: corner.color, 
                transparent: true, 
                opacity: corner.opacity,
                depthTest: false 
            })
        );
        
        box.position.set(
            (corner.minX + corner.maxX) / 2,
            sInfo.baseY,
            (corner.minZ + corner.maxZ) / 2
        );
        
        cornerGroup.add(box);
    });
    
    scene.add(cornerGroup);
    
    // Also add the original SW corner highlight at structure position
    const highlight = new THREE.Mesh(
        new THREE.BoxGeometry(1, 1, 1),
        new THREE.MeshBasicMaterial({ 
            color: 0xffff00, 
            transparent: true, 
            opacity: 0.3,
            depthTest: false 
        })
    );
    
    // Position at SW corner (max X, max Z) - where missing voxel would be
    highlight.position.set(
        sInfo.rMaxX + 0.5,  // Beyond the max boundary
        sInfo.baseY,
        sInfo.rMaxZ + 0.5   // Beyond the max boundary
    );
    highlight.name = 'swCornerHighlight';
    scene.add(highlight);
}

function updateCornerScores() {
    if (!transformPanel || !transformPanelObject) return;
    
    const sid = transformPanelObject.userData?.structureId ?? (focusedStructure && focusedStructure.id);
    if (!sid) return;
    
    const sInfo = computeStructureFoundationInfo(sid);
    if (!sInfo) return;
    
    // Update visual highlights to show current position
    showSWCornerHighlight();
    
    // Get current model bounding box
    const testBox = new THREE.Box3().setFromObject(transformPanelObject);
    
    // Define 1x1 corner regions one voxel outside the structure diagonally (same as visual highlights)
    const voxelSize = 1.0;
    const corners = {
        SW: { minX: sInfo.rMaxX, maxX: sInfo.rMaxX + voxelSize, 
              minZ: sInfo.rMaxZ, maxZ: sInfo.rMaxZ + voxelSize },
        SE: { minX: sInfo.rMinX - voxelSize, maxX: sInfo.rMinX, 
              minZ: sInfo.rMaxZ, maxZ: sInfo.rMaxZ + voxelSize },
        NW: { minX: sInfo.rMaxX, maxX: sInfo.rMaxX + voxelSize, 
              minZ: sInfo.rMinZ - voxelSize, maxZ: sInfo.rMinZ },
        NE: { minX: sInfo.rMinX - voxelSize, maxX: sInfo.rMinX, 
              minZ: sInfo.rMinZ - voxelSize, maxZ: sInfo.rMinZ }
    };
    
    // Check if each corner region contains model geometry (filled vs empty)
    let cornerStatus = { SW: false, SE: false, NW: false, NE: false };
    const yTolerance = 0.5;
    
    // Use raycasting to detect if there's geometry in each corner
    const raycaster = new THREE.Raycaster();
    
    Object.keys(corners).forEach(cornerName => {
        const corner = corners[cornerName];
        
        // Test multiple points within the corner region
        const testPoints = [
            { x: corner.minX + 0.1, z: corner.minZ + 0.1 },
            { x: corner.maxX - 0.1, z: corner.minZ + 0.1 },
            { x: corner.minX + 0.1, z: corner.maxZ - 0.1 },
            { x: corner.maxX - 0.1, z: corner.maxZ - 0.1 },
            { x: (corner.minX + corner.maxX) / 2, z: (corner.minZ + corner.maxZ) / 2 }
        ];
        
        // Cast rays downward from above to check for geometry
        for (const point of testPoints) {
            raycaster.set(
                new THREE.Vector3(point.x, sInfo.baseY + 2, point.z),
                new THREE.Vector3(0, -1, 0)
            );
            
            const intersects = raycaster.intersectObject(transformPanelObject, true);
            
            // Check if any intersection is near the base level
            for (const hit of intersects) {
                if (Math.abs(hit.point.y - sInfo.baseY) < yTolerance) {
                    cornerStatus[cornerName] = true;
                    break;
                }
            }
            
            if (cornerStatus[cornerName]) break;
        }
    });
    
    // Update the display with filled (■) or empty (□) indicators
    const getIcon = (filled) => filled ? '■' : '□';
    const getStyle = (filled) => filled ? 'color:#0a0' : 'color:#d00';
    
    document.getElementById('swScore').innerHTML = `<span style="${getStyle(cornerStatus.SW)}">${getIcon(cornerStatus.SW)}</span>`;
    document.getElementById('seScore').innerHTML = `<span style="${getStyle(cornerStatus.SE)}">${getIcon(cornerStatus.SE)}</span>`;
    document.getElementById('nwScore').innerHTML = `<span style="${getStyle(cornerStatus.NW)}">${getIcon(cornerStatus.NW)}</span>`;
    document.getElementById('neScore').innerHTML = `<span style="${getStyle(cornerStatus.NE)}">${getIcon(cornerStatus.NE)}</span>`;
}

function updateTransformPanel() {
    if (!transformPanel || !transformPanelObject || isUpdatingFromPanel) return;
    const o = transformPanelObject;
    transformPanel.querySelector('#tx').value = o.position.x.toFixed(2);
    transformPanel.querySelector('#ty').value = o.position.y.toFixed(2);
    transformPanel.querySelector('#tz').value = o.position.z.toFixed(2);
    transformPanel.querySelector('#rx').value = (THREE.MathUtils.radToDeg(o.rotation.x)).toFixed(1);
    transformPanel.querySelector('#ry').value = (THREE.MathUtils.radToDeg(o.rotation.y)).toFixed(1);
    transformPanel.querySelector('#rz').value = (THREE.MathUtils.radToDeg(o.rotation.z)).toFixed(1);
    transformPanel.querySelector('#sx').value = (o.scale.x * METERS_PER_SEGMENT).toFixed(2);
    transformPanel.querySelector('#sy').value = (o.scale.y * METERS_PER_SEGMENT).toFixed(2);
    transformPanel.querySelector('#sz').value = (o.scale.z * METERS_PER_SEGMENT).toFixed(2);
}

// Update panel continuously
function animateTransformPanel() {
    updateTransformPanel();
    requestAnimationFrame(animateTransformPanel);
}
requestAnimationFrame(animateTransformPanel);

function init() {
    if (!THREE) {
        console.error('THREE.js not loaded');
        return;
    }
    
    try {
        // Try to load environment variables from .env at startup (non-blocking)
        ensureEnvLoaded();
        scene = new THREE.Scene();
        scene.background = new THREE.Color(0xf0f0f0);
    
    const container = document.getElementById('scene-container');
    const width = container.clientWidth;
    const height = container.clientHeight;
    
    const frustumSize = 30;
    const aspect = width / height;
    camera = new THREE.OrthographicCamera(
        frustumSize * aspect / -2,
        frustumSize * aspect / 2,
        frustumSize / 2,
        frustumSize / -2,
        0.1,
        1000
    );
    camera.position.set(20, 20, 20);
    camera.lookAt(0, 0, 0);
    
    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(width, height);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(renderer.domElement);
    
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
    scene.add(ambientLight);
    
    const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
    directionalLight.position.set(10, 20, 10);
    directionalLight.castShadow = true;
    directionalLight.shadow.camera.left = -20;
    directionalLight.shadow.camera.right = 20;
    directionalLight.shadow.camera.top = 20;
    directionalLight.shadow.camera.bottom = -20;
    scene.add(directionalLight);
    
    createGroundGrid();
    
    // Show origin marker at (0,0,0)
    try { setOriginMarkerVisible(true); } catch {}
    
    gizmoGroup = new THREE.Group();
    scene.add(gizmoGroup);
    
    previewGroup = new THREE.Group();
    scene.add(previewGroup);
    
    raycaster = new THREE.Raycaster();
    mouse = new THREE.Vector2();
    
    setupControls();
    setupEventListeners();
    ensurePersistToggle();
    restorePersistentState();
    window.addEventListener('beforeunload', () => { persistStateIfEnabled(); });
    
    animate();
    } catch (error) {
        console.error('Error initializing scene:', error);
    }

    // Axis indicator removed
    axisScene = null;
    axisCamera = null;
    axisRenderer = null;
    axisHelper = null;
}

function createGroundGrid() {
    // Clear existing grid
    clearGroundGrid();
    
    const maxGridSize = Math.max(gridSizeX, gridSizeZ);
    const gridHelper = new THREE.GridHelper(maxGridSize, maxGridSize, 0x888888, 0xcccccc);
    gridHelper.userData.isGridHelper = true;
    scene.add(gridHelper);
    
    const planeGeometry = new THREE.PlaneGeometry(maxGridSize, maxGridSize);
    const planeMaterial = new THREE.MeshBasicMaterial({ 
        color: 0xffffff, 
        opacity: 0.1, 
        transparent: true,
        side: THREE.DoubleSide
    });
    const plane = new THREE.Mesh(planeGeometry, planeMaterial);
    plane.rotation.x = -Math.PI / 2;
    plane.receiveShadow = true;
    plane.userData.isGridPlane = true;
    scene.add(plane);
    
    groundGrid = [];
    for (let x = 0; x < gridSizeX; x++) {
        groundGrid[x] = [];
        for (let z = 0; z < gridSizeZ; z++) {
            const geometry = new THREE.BoxGeometry(voxelSize, voxelSize, voxelSize);
            const material = new THREE.MeshPhongMaterial({ 
                color: 0xe0e0e0,
                emissive: 0x000000,
                emissiveIntensity: 0
            });
            const cube = new THREE.Mesh(geometry, material);
            cube.position.set(
                Math.floor(x - gridSizeX / 2 + 0.5),
                0,
                Math.floor(z - gridSizeZ / 2 + 0.5)
            );
            cube.userData = { gridX: x, gridZ: z, type: 'ground', selected: false, baseColor: 0xe0e0e0 };
            cube.castShadow = true;
            cube.receiveShadow = true;
            
            // Add edge highlights
            const edges = new THREE.EdgesGeometry(geometry);
            const edgeMaterial = new THREE.LineBasicMaterial({ color: 0x000000, linewidth: 1 });
            const edgeLines = new THREE.LineSegments(edges, edgeMaterial);
            edgeLines.position.copy(cube.position);
            cube.userData.edges = edgeLines;
            scene.add(edgeLines);
            
            // Apply height-based coloring
            updateVoxelColor(cube);
            
            scene.add(cube);
            groundGrid[x][z] = cube;
        }
    }
}

function clearGroundGrid() {
    // Remove existing grid voxels
    if (groundGrid.length > 0) {
        groundGrid.flat().forEach(voxel => {
            if (voxel) {
                scene.remove(voxel);
                
                // Remove edges if they exist
                if (voxel.userData.edges) {
                    scene.remove(voxel.userData.edges);
                    if (voxel.userData.edges.geometry) voxel.userData.edges.geometry.dispose();
                    if (voxel.userData.edges.material) voxel.userData.edges.material.dispose();
                }
                
                voxel.geometry.dispose();
                voxel.material.dispose();
            }
        });
    }
    
    // Remove grid helper and plane
    scene.children.filter(child => 
        child.userData.isGridHelper || child.userData.isGridPlane
    ).forEach(child => {
        scene.remove(child);
        if (child.geometry) child.geometry.dispose();
        if (child.material) child.material.dispose();
    });
}

// Origin marker at (0,0,0)
function ensureOriginMarker() {
	if (originMarker) return originMarker;
	const group = new THREE.Group();
	group.name = 'originMarker';
	const size = Math.max(0.5, 0.8 * voxelSize);
	const thickness = Math.max(0.02, 0.06 * voxelSize);
	const cylGeo = new THREE.CylinderGeometry(thickness, thickness, size, 8);
	const matX = new THREE.MeshBasicMaterial({ color: 0xff3333 });
	const matY = new THREE.MeshBasicMaterial({ color: 0x33ff33 });
	const matZ = new THREE.MeshBasicMaterial({ color: 0x3333ff });
	const mx = new THREE.Mesh(cylGeo, matX); mx.rotation.z = Math.PI/2; mx.position.x = size/2; group.add(mx);
	const mz = new THREE.Mesh(cylGeo, matZ); mz.rotation.x = Math.PI/2; mz.position.z = size/2; group.add(mz);
	const my = new THREE.Mesh(cylGeo, matY); my.position.y = size/2; group.add(my);
	const axes = new THREE.AxesHelper(size * 0.9);
	axes.material.depthTest = false; axes.renderOrder = 999; group.add(axes);
	group.traverse(n=>{ if(n.isMesh){ n.renderOrder = 998; }});
	group.position.set(0, 0, 0);
	originMarker = group;
	scene.add(group);
	return group;
}
function setOriginMarkerVisible(visible) {
	const m = ensureOriginMarker();
	m.visible = !!visible;
}

function setupControls() {
    renderer.domElement.addEventListener('wheel', (event) => {
        event.preventDefault();
        const zoomSpeed = 0.002;
        currentZoom *= 1 - (event.deltaY * zoomSpeed);
        currentZoom = Math.max(0.3, Math.min(4, currentZoom));
        
        const frustumSize = 30 / currentZoom;
        const aspect = camera.aspect || (camera.right - camera.left) / (camera.top - camera.bottom);
        
        camera.left = frustumSize * aspect / -2;
        camera.right = frustumSize * aspect / 2;
        camera.top = frustumSize / 2;
        camera.bottom = frustumSize / -2;
        camera.updateProjectionMatrix();
    });
    
    let isRotating = false;
    let isPanning = false;
    let previousMousePosition = { x: 0, y: 0 };
    let cameraTarget = new THREE.Vector3(0, 0, 0);
    
    renderer.domElement.addEventListener('mousedown', (event) => {
        if (event.button === 2) {
            if (shiftPressed) {
                isPanning = true;
            } else {
                isRotating = true;
            }
            previousMousePosition = { x: event.clientX, y: event.clientY };
        }
    });
    
    renderer.domElement.addEventListener('mousemove', (event) => {
        if (isRotating && !isPanning) {
            const deltaX = event.clientX - previousMousePosition.x;
            const deltaY = event.clientY - previousMousePosition.y;
            
            const rotationSpeed = 0.005;
            const spherical = new THREE.Spherical();
            spherical.setFromVector3(camera.position.clone().sub(cameraTarget));
            spherical.theta -= deltaX * rotationSpeed;
            spherical.phi += deltaY * rotationSpeed;
            spherical.phi = Math.max(0.1, Math.min(Math.PI - 0.1, spherical.phi));
            
            camera.position.setFromSpherical(spherical).add(cameraTarget);
            camera.lookAt(cameraTarget);
            
            previousMousePosition = { x: event.clientX, y: event.clientY };
        } else if (isPanning) {
            const deltaX = event.clientX - previousMousePosition.x;
            const deltaY = event.clientY - previousMousePosition.y;
            
            const panSpeed = 0.02;
            const right = new THREE.Vector3();
            const up = new THREE.Vector3();
            
            camera.getWorldDirection(right);
            right.cross(camera.up).normalize();
            up.copy(camera.up);
            
            const panVector = new THREE.Vector3();
            panVector.addScaledVector(right, -deltaX * panSpeed);
            panVector.addScaledVector(up, deltaY * panSpeed);
            
            camera.position.add(panVector);
            cameraTarget.add(panVector);
            camera.lookAt(cameraTarget);
            
            previousMousePosition = { x: event.clientX, y: event.clientY };
        }
    });
    
    renderer.domElement.addEventListener('mouseup', () => {
        isRotating = false;
        isPanning = false;
    });
    
    renderer.domElement.addEventListener('contextmenu', (e) => e.preventDefault());
}

function setupEventListeners() {
    renderer.domElement.addEventListener('mousedown', onMouseDown);
    renderer.domElement.addEventListener('mousemove', onMouseMove);
    renderer.domElement.addEventListener('mouseup', onMouseUp);
    
    document.getElementById('selectBtn').addEventListener('click', () => {
        currentTool = 'select';
        updateToolButtons();
    });
    
    document.getElementById('saveStructureBtn').addEventListener('click', saveSelectedStructure);
    const resetBtn = document.getElementById('resetCameraBtn');
    if (resetBtn) {
        resetBtn.addEventListener('click', () => snapSceneCameraToDefaultIso());
    }
    
    // HUD transform controls
    const hud = document.getElementById('transformHud');
    const hudMove = document.getElementById('hudMove');
    const hudRotate = document.getElementById('hudRotate');
    const hudScale = document.getElementById('hudScale');
    if (hudMove) hudMove.addEventListener('click', () => tripoTransformControls?.setMode('translate'));
    if (hudRotate) hudRotate.addEventListener('click', () => tripoTransformControls?.setMode('rotate'));
    if (hudScale) hudScale.addEventListener('click', () => tripoTransformControls?.setMode('scale'));
    
    // Make focus indicator clickable to exit focus mode
    const focusIndicatorEl = document.getElementById('focusIndicator');
    if (focusIndicatorEl) {
        focusIndicatorEl.style.cursor = 'pointer';
        focusIndicatorEl.title = 'Click to exit focus mode';
        focusIndicatorEl.addEventListener('click', () => {
            if (focusMode) toggleFocusMode();
        });
    }
    
    window.addEventListener('resize', onWindowResize);
    
    // Keyboard events
    window.addEventListener('keydown', (event) => {
        // Disable ALL hotkeys when typing into an input, textarea, select, or content-editable
        if (isTypingIntoInput(event)) return;

        if (event.key === 'f' || event.key === 'F') {
            event.preventDefault();
            toggleFocusMode();
            return;
        }
        if (event.key === ' ' || event.key === 'Spacebar') {
            event.preventDefault();
            clearSelection();
            hideGizmos();
            return;
        }

        // For the rest, respect typing context
        if (isTypingIntoInput(event)) return;

        if (event.key === 'Shift') {
            shiftPressed = true;
            if (selectedVoxels.length > 0) {
                createGizmos();
            }
        } else if (tripoTransformControls) {
            // W/E/R when transform controls are present
            if (event.key === 'w' || event.key === 'W') {
                tripoTransformControls.setMode('translate');
            } else if (event.key === 'e' || event.key === 'E') {
                tripoTransformControls.setMode('rotate');
            } else if (event.key === 'r' || event.key === 'R') {
                tripoTransformControls.setMode('scale');
            }
        } else if (event.key === 'Delete' || event.key === 'Backspace') {
            event.preventDefault();
            deleteSelectedVoxels();
        }
    });
    
    window.addEventListener('keyup', (event) => {
        if (isTypingIntoInput(event)) return;
        if (event.key === 'Shift') {
            shiftPressed = false;
            if (!isDraggingGizmo) {
                hideGizmos();
            }
        }
    });
    
    // Grid size slider events
    const gridXSlider = document.getElementById('gridXSlider');
    const gridXValue = document.getElementById('gridXValue');
    const gridZSlider = document.getElementById('gridZSlider');
    const gridZValue = document.getElementById('gridZValue');
    
    gridXSlider.addEventListener('input', (event) => {
        gridSizeX = parseInt(event.target.value);
        gridXValue.textContent = gridSizeX;
        createGroundGrid();
        clearSelection();
        hideGizmos();
    });
    
    gridZSlider.addEventListener('input', (event) => {
        gridSizeZ = parseInt(event.target.value);
        gridZValue.textContent = gridSizeZ;
        createGroundGrid();
        clearSelection();
        hideGizmos();
    });
    
    // Height slider events
    const heightSlider = document.getElementById('heightSlider');
    const heightValue = document.getElementById('heightValue');
    
    heightSlider.addEventListener('input', (event) => {
        heightLimit = parseInt(event.target.value);
        heightValue.textContent = heightLimit;
        updateAllVoxelColors();
    });
    
    // Buildify menu events
    setupBuildifyEvents();
}

function updateToolButtons() {
    document.querySelectorAll('.tool-btn').forEach(btn => {
        btn.classList.remove('active');
    });
    
    if (currentTool === 'select') {
        document.getElementById('selectBtn').classList.add('active');
    }
}

function onMouseDown(event) {
    if (event.button === 2) return; // Ignore right click for rotation
    
    const container = document.getElementById('scene-container');
    const rect = container.getBoundingClientRect();
    
    mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    
    raycaster.setFromCamera(mouse, camera);
    
    // Check for gizmo intersection only if shift is held and gizmo is visible
    if (shiftPressed && gizmoGroup.children.length > 0) {
        const gizmoIntersects = raycaster.intersectObjects(gizmoGroup.children, true);
        if (gizmoIntersects.length > 0) {
            const gizmoObject = gizmoIntersects[0].object.parent || gizmoIntersects[0].object;
            startGizmoDrag(gizmoObject, event);
            return;
        }
    }
    
    // Check for voxel selection
    const allObjects = [...groundGrid.flat(), ...voxels];
    const intersects = raycaster.intersectObjects(allObjects);
    
    if (intersects.length > 0) {
        const object = intersects[0].object;
        // Default behavior is now multi-select (toggle)
        toggleSelection(object);
        
        // Only update gizmos if shift is pressed
        if (shiftPressed && selectedVoxels.length > 0) {
            createGizmos();
        }
    }
}

function onMouseMove(event) {
    if (!isDraggingGizmo) return;
    
    const container = document.getElementById('scene-container');
    const rect = container.getBoundingClientRect();
    
    mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    
    updateDragPreview(event);
}

function onMouseUp(event) {
    if (isDraggingGizmo) {
        finishGizmoDrag();
    }
}

function toggleSelection(object) {
    // Prevent selecting ground grid while in focus mode
    if (focusMode && object?.userData?.type === 'ground') return;
    if (object.userData.isGizmo) return;
    
    const index = selectedVoxels.indexOf(object);
    
    if (index === -1) {
        selectedVoxels.push(object);
        object.userData.selected = true;
        object.material.emissiveIntensity = 0.3;
        object.material.emissive = new THREE.Color(0x4444ff);
    } else {
        selectedVoxels.splice(index, 1);
        object.userData.selected = false;
        object.material.emissiveIntensity = 0;
    }
}

function clearSelection() {
    selectedVoxels.forEach(voxel => {
        voxel.userData.selected = false;
        voxel.material.emissiveIntensity = 0;
    });
    selectedVoxels = [];
    hideGizmos();
}


function createGizmos() {
    hideGizmos();
    
    if (selectedVoxels.length === 0) return;
    
    const bounds = new THREE.Box3();
    selectedVoxels.forEach(voxel => {
        bounds.expandByObject(voxel);
    });
    
    const center = new THREE.Vector3();
    bounds.getCenter(center);
    
    const arrowLength = 3;
    const arrowHeadLength = 1;
    const arrowHeadWidth = 0.5;
    
    const xArrow = new THREE.ArrowHelper(
        new THREE.Vector3(1, 0, 0),
        center,
        arrowLength,
        0xff0000,
        arrowHeadLength,
        arrowHeadWidth
    );
    xArrow.userData = { isGizmo: true, axis: 'x' };
    
    const yArrow = new THREE.ArrowHelper(
        new THREE.Vector3(0, 1, 0),
        center,
        arrowLength,
        0x00ff00,
        arrowHeadLength,
        arrowHeadWidth
    );
    yArrow.userData = { isGizmo: true, axis: 'y' };
    
    const zArrow = new THREE.ArrowHelper(
        new THREE.Vector3(0, 0, 1),
        center,
        arrowLength,
        0x0000ff,
        arrowHeadLength,
        arrowHeadWidth
    );
    zArrow.userData = { isGizmo: true, axis: 'z' };
    
    const negXArrow = new THREE.ArrowHelper(
        new THREE.Vector3(-1, 0, 0),
        center,
        arrowLength,
        0x880000,
        arrowHeadLength,
        arrowHeadWidth
    );
    negXArrow.userData = { isGizmo: true, axis: 'x', negative: true };
    
    const negYArrow = new THREE.ArrowHelper(
        new THREE.Vector3(0, -1, 0),
        center,
        arrowLength,
        0x008800,
        arrowHeadLength,
        arrowHeadWidth
    );
    negYArrow.userData = { isGizmo: true, axis: 'y', negative: true };
    
    const negZArrow = new THREE.ArrowHelper(
        new THREE.Vector3(0, 0, -1),
        center,
        arrowLength,
        0x000088,
        arrowHeadLength,
        arrowHeadWidth
    );
    negZArrow.userData = { isGizmo: true, axis: 'z', negative: true };
    
    gizmoGroup.add(xArrow, yArrow, zArrow, negXArrow, negYArrow, negZArrow);
}

function hideGizmos() {
    while(gizmoGroup.children.length > 0) {
        gizmoGroup.remove(gizmoGroup.children[0]);
    }
}

function getHeightBasedColor(baseColor, yPosition) {
    // Calculate darkness factor based on Y position (0 at ground, 1 at heightLimit)
    const heightFactor = Math.max(0, Math.min(1, yPosition / heightLimit));
    
    // Convert hex color to RGB
    const color = new THREE.Color(baseColor);
    
    // Apply darkness factor (multiply by 1 - heightFactor)
    const darkness = 1 - heightFactor;
    color.multiplyScalar(darkness);
    
    return color;
}

function updateVoxelColor(voxel) {
    const baseColor = voxel.userData.baseColor || 0xe0e0e0;
    const newColor = getHeightBasedColor(baseColor, voxel.position.y);
    voxel.material.color.copy(newColor);
}

function updateAllVoxelColors() {
    // Update ground grid colors
    groundGrid.flat().forEach(voxel => {
        updateVoxelColor(voxel);
    });
    
    // Update created voxel colors
    voxels.forEach(voxel => {
        updateVoxelColor(voxel);
    });
}

function toggleFocusMode() {
    console.log(`Focus mode toggle: currently ${focusMode ? 'ON' : 'OFF'}, focusedStructure: ${focusedStructure ? focusedStructure.id : 'null'}`);
    
    if (!focusMode) {
        // Enter focus mode - only allow if a structure is loaded
        if (!focusedStructure) {
            alert('Load a saved structure first to enter focus mode!');
            return;
        }
        
        enterFocusMode();
    } else {
        // Exit focus mode
        exitFocusMode();
    }
}

function enterFocusMode() {
    focusMode = true;
    
    // Show transform controls if the focused structure has a model
    if (focusedStructure) {
        const modelData = placedModelsByStructure.get(focusedStructure.id);
        if (modelData && modelData.group) {
            tripoModelGroup = modelData.group;
            tripoPlacementEnabled = true;
            attachTripoTransformControls(tripoModelGroup);
        }
    }
    
    // Initialize the focused structure voxels set with current structure voxels
    focusedStructureVoxels.clear();
    
    // Find all voxels that belong to the focused structure
    focusedStructure.data.forEach(voxelData => {
        const targetPos = new THREE.Vector3().fromArray(voxelData.position);
        targetPos.x = Math.round(targetPos.x);
        targetPos.y = Math.round(targetPos.y);
        targetPos.z = Math.round(targetPos.z);
        
        const allObjects = [...groundGrid.flat(), ...voxels];
        const matchingVoxel = allObjects.find(voxel => {
            const voxelPos = voxel.position;
            return Math.abs(voxelPos.x - targetPos.x) < 0.1 && 
                   Math.abs(voxelPos.y - targetPos.y) < 0.1 && 
                   Math.abs(voxelPos.z - targetPos.z) < 0.1;
        });
        
        if (matchingVoxel) {
            focusedStructureVoxels.add(matchingVoxel);
        }
    });
    
    // Select all structure voxels
    clearSelection();
    focusedStructureVoxels.forEach(voxel => {
        toggleSelection(voxel);
    });
    
    // Update visibility - hide all non-structure voxels and ground grid
    updateFocusModeVisibility();
    
    // Show focus indicator
    const indicator = document.getElementById('focusIndicator');
    indicator.style.display = 'block';
    
    // Show Buildify menu
    const buildifyMenu = document.getElementById('buildify-menu');
    buildifyMenu.style.display = 'flex';
    
    // Ensure foundation exists, then raise overlay grid but keep it hidden
    setGroundElevation(true);
    if (showFoundation) {
        createOrUpdateFoundation();
    }
    setGridOverlayVisible(false);
    
    console.log('Entered focus mode for structure:', focusedStructure.name);
}

function exitFocusMode() {
    focusMode = false;
    
    // Hide transform controls when exiting focus mode
    detachTripoTransformControls();

    // If procedural building is shown, clear and reset toggle
    try {
        const toggle = document.getElementById('toggleRenderBuilding');
        if (toggle && toggle.checked) {
            toggle.checked = false;
        }
    } catch {}
    renderBuildingEnabled = false;
    restoreOriginalFocusedStructure();

    // Update the focused structure with all current structure voxels
    updateFocusedStructure();
    
    // Restore all voxels to full visibility
    const allVoxels = [...groundGrid.flat(), ...voxels];
    allVoxels.forEach(voxel => {
        voxel.visible = true;
        
        // Also restore edge visibility
        if (voxel.userData && voxel.userData.edges) {
            voxel.userData.edges.visible = true;
        }
    });
    
    // Restore all placed models to full visibility
    placedModelsByStructure.forEach((modelData) => {
        if (modelData.group) {
            modelData.group.visible = true;
        }
    });
    
    // Hide focus indicator
    const indicator = document.getElementById('focusIndicator');
    indicator.style.display = 'none';
    
    // Hide Buildify menu
    const buildifyMenu = document.getElementById('buildify-menu');
    buildifyMenu.style.display = 'none';
    
    // Keep structure voxels selected
    clearSelection();
    focusedStructureVoxels.forEach(voxel => {
        toggleSelection(voxel);
    });
    
    // Lower ground plane/grid back to base
    setGroundElevation(false);
    if (!showFoundation) {
        removeFoundation();
    }
    removeTreeMarker();
    setGridOverlayVisible(true);
    
    console.log('Exited focus mode, updated structure with', focusedStructureVoxels.size, 'voxels');
}

function updateFocusModeVisibility() {
    if (!focusMode) return;
    
    // Hide the flat white grid helper/plane in focus mode to prevent clipping
    scene.children.forEach(child => {
        const isGridOverlay = child.userData && (child.userData.isGridHelper || child.userData.isGridPlane);
        if (isGridOverlay) child.visible = false;
    });

    const allVoxels = [...groundGrid.flat(), ...voxels];
    allVoxels.forEach(voxel => {
        // Hide ground grid segments in focus mode; foundation is separate and remains visible
        if (voxel.userData?.type === 'ground') {
            voxel.visible = false;
            if (voxel.userData.edges) voxel.userData.edges.visible = false;
            return;
        }
        // Show only voxels that are part of the focused structure
        const isVisible = focusedStructureVoxels.has(voxel);
        voxel.visible = isVisible;
        
        // Also toggle edge visibility
        if (voxel.userData && voxel.userData.edges) {
            voxel.userData.edges.visible = isVisible;
        }
    });

    // Hide all unrelated placed models when focusing on a structure
    placedModelsByStructure.forEach((modelData, structureId) => {
        if (modelData.group) {
            modelData.group.visible = (focusedStructure && structureId === focusedStructure.id);
        }
    });
}

function addVoxelToFocusedStructure(voxel) {
    if (focusMode && voxel && !focusedStructureVoxels.has(voxel)) {
        focusedStructureVoxels.add(voxel);
        voxel.visible = true;
        
        // Also make edges visible
        if (voxel.userData.edges) {
            voxel.userData.edges.visible = true;
        }
    }
}

function updateFocusedStructure() {
    if (!focusedStructure || focusedStructureVoxels.size === 0) return;
    
    // Update the structure data with all focused structure voxels
    const structureData = Array.from(focusedStructureVoxels).map(voxel => ({
        position: voxel.position.toArray(),
        color: voxel.userData.baseColor || voxel.material.color.getHex(),
        size: voxelSize
    }));
    
    focusedStructure.data = structureData;
    
    // Find and update in savedStructures array
    const structureIndex = savedStructures.findIndex(s => s.id === focusedStructure.id);
    if (structureIndex !== -1) {
        savedStructures[structureIndex] = focusedStructure;
        updateStructuresMenu();
    }
}

function deleteSelectedVoxels() {
    if (selectedVoxels.length === 0) return;
    
    // Can't delete ground grid voxels
    const voxelsToDelete = selectedVoxels.filter(voxel => voxel.userData.type !== 'ground');
    
    if (voxelsToDelete.length === 0) {
        console.log('Cannot delete ground grid voxels');
        return;
    }
    
    voxelsToDelete.forEach(voxel => {
        // Remove from scene
        scene.remove(voxel);
        
        // Remove edges if they exist
        if (voxel.userData.edges) {
            scene.remove(voxel.userData.edges);
            if (voxel.userData.edges.geometry) voxel.userData.edges.geometry.dispose();
            if (voxel.userData.edges.material) voxel.userData.edges.material.dispose();
        }
        
        // Dispose of geometry and material
        if (voxel.geometry) voxel.geometry.dispose();
        if (voxel.material) voxel.material.dispose();
        
        // Remove from voxels array
        const voxelIndex = voxels.indexOf(voxel);
        if (voxelIndex > -1) {
            voxels.splice(voxelIndex, 1);
        }
        
        // Remove from focused structure if in focus mode
        if (focusMode && focusedStructureVoxels.has(voxel)) {
            focusedStructureVoxels.delete(voxel);
        }
        
        // Remove from selected voxels
        const selectedIndex = selectedVoxels.indexOf(voxel);
        if (selectedIndex > -1) {
            selectedVoxels.splice(selectedIndex, 1);
        }
    });
    
    // Update gizmos after deletion
    updateGizmos();
    
    console.log('Deleted', voxelsToDelete.length, 'voxels');
}

function setupBuildifyEvents() {
    const closeBuildify = document.getElementById('closeBuildify');
    const captureBtn = document.getElementById('captureStructureBtn');
    const sendFalDepthBtn = document.getElementById('sendFalDepthBtn');
    const toggleFoundationEl = document.getElementById('toggleFoundation');

    if (closeBuildify) {
        closeBuildify.addEventListener('click', () => {
            const buildifyMenu = document.getElementById('buildify-menu');
            buildifyMenu.style.display = 'none';
        });
    }

    if (captureBtn) {
        captureBtn.addEventListener('click', async () => {
            await handleCaptureStructure();
        });
    }

    if (sendFalDepthBtn) {
        sendFalDepthBtn.addEventListener('click', async () => {
            try {
                await sendIsometricToFalDepth();
            } catch (e) {
                console.error('FLUX Depth call failed:', e);
                alert('FLUX Depth call failed. See console for details.');
            }
        });
    }

    if (toggleFoundationEl) {
        toggleFoundationEl.addEventListener('change', (e) => {
            showFoundation = !!e.target.checked;
            if (showFoundation) {
                createOrUpdateFoundation();
                createOrUpdateTreeMarker();
                setGridOverlayVisible(false);
            } else {
                removeFoundation();
                removeTreeMarker();
                setGridOverlayVisible(true);
            }
        });
    }
}

async function handleCaptureStructure() {
    try {
        if (!focusedStructure) {
            alert('No active structure. Load a structure first.');
            return;
        }

        const structureVoxels = collectVoxelsForStructure(focusedStructure);
        if (structureVoxels.size === 0) {
            alert('Could not find voxels for the active structure in the scene.');
            return;
        }
        const bounds = computeBoundsForVoxelSet(structureVoxels);

        // Hide non-structure elements (and flat grid) but keep segmented ground visible
        const { restore } = isolateForCapture(structureVoxels);

        // Only capture the color image (remove depth capture)
        const size = 768;
        const camIso = createOrthoObliqueCameraToFit(bounds, size, size, DEFAULT_ISO_ELEVATION_DEG, DEFAULT_ISO_AZIMUTH_DEG);
        // Give more headroom so the foundation (outer ring and corner cut) is never cropped
        expandOrthoFrustum(camIso, 1.30);
        camIso.updateMatrixWorld(true);

        // Ensure foundation exists for capture and remove bottom-right corner relative to this camera
        if (showFoundation) {
            createOrUpdateFoundation(bounds, camIso);
            setGridOverlayVisible(false);
        }

        // Build and place a temporary tree only if foundation is not enabled
        // Tree dimensions relative to segment: trunk height ~1.2, crown radius ~0.8
        const addVoxelTree = (cam) => {
            const treeGroup = new THREE.Group();
            treeGroup.userData.__tempMarker = true;
            const unit = 0.1 * voxelSize; // 1/10 of a segment
            // Use the same blue as highlighted segments
            const structColor = 0x4444ff;
            const leafMat = new THREE.MeshPhongMaterial({ color: structColor });
            const woodMat = leafMat; // same material/color per requirement
            const makeVoxel = (x,y,z,mat) => {
                const g = new THREE.BoxGeometry(unit, unit, unit);
                const mesh = new THREE.Mesh(g, mat);
                mesh.position.set(x, y, z);
                treeGroup.add(mesh);
            };
            // Trunk (slightly tapered)
            const trunkH = Math.round(1.35 / 0.1);
            for (let iy = 0; iy < trunkH; iy++) {
                const r = Math.max(1, Math.round((0.2 - iy * 0.2 / trunkH) / 0.1));
                for (let ix = -r; ix <= r; ix++) {
                    for (let iz = -r; iz <= r; iz++) {
                        if (ix*ix + iz*iz <= r*r) makeVoxel(ix*unit, iy*unit, iz*unit, woodMat);
                    }
                }
            }
            // Branches: four branches at different heights and azimuths
            const branchSpecs = [
                { h: 0.6,  a: -35, len: 0.6 },
                { h: 0.9,  a: 25,  len: 0.55 },
                { h: 1.15, a: 70,  len: 0.5 },
                { h: 1.05, a: 150, len: 0.45 }
            ];
            const toRad = (d)=>d*Math.PI/180;
            for (const b of branchSpecs) {
                const yBase = Math.round(b.h / 0.1) * unit;
                const steps = Math.round(b.len / 0.1);
                const dir = new THREE.Vector3(Math.cos(toRad(b.a)), 0, Math.sin(toRad(b.a)));
                for (let s = 1; s <= steps; s++) {
                    const p = dir.clone().multiplyScalar(s*unit);
                    makeVoxel(p.x, yBase + Math.round(s*0.03/unit)*unit, p.z, woodMat);
                    // branch thickness 1 voxel with occasional side voxel
                    if (s % 3 === 0) {
                        const side = new THREE.Vector3(-dir.z, 0, dir.x).multiplyScalar(unit);
                        makeVoxel(p.x + side.x, yBase + Math.round(s*0.03/unit)*unit, p.z + side.z, woodMat);
                    }
                }
                // Leaf cluster at branch tip (non-uniform small blob)
                const tip = dir.clone().multiplyScalar(steps*unit);
                const rLeaf = Math.round(0.3 / 0.1);
                for (let iy = -rLeaf; iy <= rLeaf; iy++) {
                    for (let ix = -rLeaf; ix <= rLeaf; ix++) {
                        for (let iz = -rLeaf; iz <= rLeaf; iz++) {
                            const ell = (ix*ix)/(rLeaf*rLeaf) + (iy*iy)/(rLeaf*rLeaf*0.7) + (iz*iz)/(rLeaf*rLeaf);
                            if (ell <= 1.0 && Math.random() > 0.12) {
                                makeVoxel(tip.x + ix*unit, yBase + iy*unit, tip.z + iz*unit, leafMat);
                            }
                        }
                    }
                }
            }
            // Canopy cap above trunk (irregular dome)
            const crownR = Math.round(0.7 / 0.1);
            const crownBaseY = trunkH * unit + 2 * unit;
            for (let iy = 0; iy <= crownR; iy++) {
                const layerR = crownR - iy + (Math.random()>0.6? -1:0);
                for (let ix = -layerR; ix <= layerR; ix++) {
                    for (let iz = -layerR; iz <= layerR; iz++) {
                        if (ix*ix + iz*iz <= layerR*layerR && Math.random() > 0.1) {
                            makeVoxel(ix*unit, crownBaseY + iy*unit, iz*unit, leafMat);
                        }
                    }
                }
            }

            // Compute world placement at bottom-left of the image by raycasting NDC to ground plane
            const raycaster = new THREE.Raycaster();
            const ndc = new THREE.Vector2(-0.86, -0.9); // near bottom-left but not cropped
            raycaster.setFromCamera(ndc, cam);
            const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -bounds.min.y);
            const pos = new THREE.Vector3();
            raycaster.ray.intersectPlane(groundPlane, pos);
            // Ensure not overlapping: if inside structure (with margin), push outward from center
            const margin = 0.4;
            const cx = (bounds.min.x + bounds.max.x) * 0.5;
            const cz = (bounds.min.z + bounds.max.z) * 0.5;
            const inside = (pos.x > bounds.min.x - margin && pos.x < bounds.max.x + margin && pos.z > bounds.min.z - margin && pos.z < bounds.max.z + margin);
            if (inside) {
                const pushDir = new THREE.Vector3(pos.x - cx, 0, pos.z - cz).normalize();
                if (pushDir.lengthSq() < 1e-6) pushDir.set(-1,0,1).normalize();
                pos.add(pushDir.multiplyScalar(margin + 0.6));
            }
            // Nudge inward from the extreme left edge to avoid cropping
            {
                const center = new THREE.Vector3().addVectors(bounds.min, bounds.max).multiplyScalar(0.5);
                const camDir = center.clone().sub(cam.position).normalize();
                const right = new THREE.Vector3().crossVectors(camDir, new THREE.Vector3(0,1,0)).normalize();
                pos.add(right.multiplyScalar(0.2));
            }
            // Snap exactly to ground and apply small epsilon to avoid z-fighting
            pos.y = bounds.min.y + unit * 0.5;
            treeGroup.position.copy(pos);
            scene.add(treeGroup);
            return treeGroup;
        };
        let tempTree = null;
        if (!showFoundation) {
            tempTree = addVoxelTree(camIso);
        }

        const isoColorUrl = renderToDataURL(camIso, size, size, { clearColor: 0xffffff });
        
        restore();
        // Remove tree marker
        if (typeof tempTree !== 'undefined' && tempTree) {
            tempTree.traverse(n=>{ if(n.isMesh){ n.geometry?.dispose?.(); n.material?.dispose?.(); } });
            scene.remove(tempTree);
        }
        if (showFoundation) {
            // Recreate foundation for scene camera and keep grid hidden while toggle is on
            createOrUpdateFoundation();
            setGridOverlayVisible(false);
        }

        // Store the captured image for Send to Flux
        latestCapturedImageUrl = isoColorUrl;
        
        // Update preview in buildify menu
        updateCapturePreview(isoColorUrl);
        
        // Add captured image to gallery (don't clear existing)
        displayCapturedImages([
            { label: 'ISOMETRIC COLOR', dataUrl: isoColorUrl }
        ]);
        showToast('Structure captured', 'success');
    } catch (e) {
        console.error('Capture failed:', e);
        showToast('Capture failed', 'error');
    }
}

function displayCapturedImages(images) {
    const gallery = document.getElementById('captureGallery');
    if (!gallery) return;
    // Don't clear gallery - append new images to existing ones
    images.forEach(img => {
        appendGalleryImage(img.label, img.dataUrl, focusedStructure ? focusedStructure.id : undefined);
    });
    // Save gallery state for current structure
    saveCurrentGalleryState();
    // Ensure bottom bar list is visible by updating menu
    updateStructuresMenu();
    persistStateIfEnabled();
}

function updateCapturePreview(imageUrl) {
    const previewPlaceholder = document.getElementById('capturePreviewPlaceholder');
    const previewImage = document.getElementById('capturePreviewImage');
    const captureBtn = document.getElementById('captureStructureBtn');
    
    if (previewPlaceholder) previewPlaceholder.style.display = 'none';
    if (previewImage) {
        previewImage.src = imageUrl;
        previewImage.style.display = 'block';
    }
    if (captureBtn) {
        captureBtn.textContent = 'Recapture Structure';
    }
}

function resetCapturePreview() {
    const previewPlaceholder = document.getElementById('capturePreviewPlaceholder');
    const previewImage = document.getElementById('capturePreviewImage');
    const captureBtn = document.getElementById('captureStructureBtn');
    
    if (previewPlaceholder) previewPlaceholder.style.display = 'block';
    if (previewImage) previewImage.style.display = 'none';
    if (captureBtn) {
        captureBtn.textContent = 'Capture Structure';
    }
    latestCapturedImageUrl = null;
}

function saveCurrentGalleryState() {
    if (!focusedStructure) return;
    const gallery = document.getElementById('captureGallery');
    if (!gallery) return;
    
    // Save current gallery HTML for this structure
    structureGalleries.set(focusedStructure.id, gallery.innerHTML);
}

function saveGalleryStateForStructure(structureId) {
    if (structureId == null) return;
    
    // If this is the currently focused structure, save from DOM
    if (focusedStructure && focusedStructure.id === structureId) {
        saveCurrentGalleryState();
    }
    // Otherwise, the gallery state should already be up to date in the Map
}

function addItemToStructureGallery(item, structureId) {
    if (structureId == null) return;
    
    // Get current gallery HTML for this structure
    const existingGalleryHtml = structureGalleries.get(structureId) || '';
    
    // Create a temporary container to manipulate the HTML
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = existingGalleryHtml;
    
    // Add the new item to the beginning
    tempDiv.insertBefore(item.cloneNode(true), tempDiv.firstChild);
    
    // Save the updated HTML back to the Map
    structureGalleries.set(structureId, tempDiv.innerHTML);
}

function loadGalleryForStructure(structureId) {
    const gallery = document.getElementById('captureGallery');
    if (!gallery) return;
    
    // Load saved gallery HTML for this structure
    const savedGallery = structureGalleries.get(structureId);
    if (savedGallery !== undefined) {
        gallery.innerHTML = savedGallery;
        // Check if this structure has a captured image
        const hasColorCapture = savedGallery.includes('ISOMETRIC COLOR');
        if (hasColorCapture) {
            // Find the captured image and update preview
            const parser = new DOMParser();
            const doc = parser.parseFromString(savedGallery, 'text/html');
            const colorItem = [...doc.querySelectorAll('.capture-item')].find(item => 
                item.dataset.label === 'ISOMETRIC COLOR'
            );
            if (colorItem && colorItem.dataset.src) {
                updateCapturePreview(colorItem.dataset.src);
                latestCapturedImageUrl = colorItem.dataset.src;
            }
        } else {
            resetCapturePreview();
        }
    } else {
        gallery.innerHTML = '';
        resetCapturePreview();
    }
    
    // Re-attach event listeners for Tripo items
    reattachGalleryEventListeners();
}

function reattachGalleryEventListeners() {
    const gallery = document.getElementById('captureGallery');
    if (!gallery) return;
    
    gallery.querySelectorAll('.capture-item').forEach(item => {
        const itemType = item.dataset.type;
        const itemSrc = item.dataset.src;
        const structureId = item.dataset.structureId;
        
        // Re-attach download button listeners
        const downloadBtn = item.querySelector('.download-btn');
        if (downloadBtn && itemSrc) {
            downloadBtn.addEventListener('click', async () => {
                if (itemType === 'tripo') {
                    const glbUrl = item.dataset.glb;
                    const fileName = makeFilename('tripo_model').replace(/\.png$/, '.glb');
                    const a = document.createElement('a');
                    a.href = glbUrl; a.download = fileName;
                    document.body.appendChild(a); a.click(); document.body.removeChild(a);
                } else {
                    const fileName = itemType === 'flux' ? 'flux_depth_result' : 'captured_image';
                    downloadDataURL(itemSrc, makeFilename(fileName));
                }
            });
        }
        
        // Re-attach Send to Tripo button listeners (for FLUX results)
        const sendTripoBtn = item.querySelector('.send-tripo-btn');
        if (sendTripoBtn && itemSrc) {
            sendTripoBtn.addEventListener('click', async () => {
                sendTripoBtn.disabled = true;
                sendTripoBtn.textContent = 'Sending...';
                try {
                    showToast('Sending to Tripo…', 'info');
                    await sendImageToTripo(itemSrc);
                    sendTripoBtn.textContent = 'Sent';
                    showToast('Sent to Tripo', 'success');
                } catch (e) {
                    console.error('Tripo send failed:', e);
                    showToast('Tripo send failed', 'error');
                    sendTripoBtn.textContent = 'SEND TO TRIPO';
                    sendTripoBtn.disabled = false;
                }
            });
        }
        
        // Re-attach stick skin button listeners
        const stickSkinBtn = item.querySelector('.stick-skin');
        if (stickSkinBtn && itemSrc) {
            stickSkinBtn.addEventListener('click', async () => {
                showToast('Preparing skin…', 'info');
                await addSkinToFocusedStructure(itemSrc);
            });
        }
        
        // If this is a TRIPO item, ensure viewer initialized and buttons wired
        if (itemType === 'tripo') {
            const viewer = item.querySelector('.tripo-viewer');
            const glbUrl = item.dataset.glb;
            if (viewer && glbUrl && viewer.childElementCount === 0) {
                initTripoViewer(viewer, glbUrl);
            }
        }
        
        // Re-attach place/remove button listeners for Tripo items
        const placeBtn = item.querySelector('.place-remove-btn');
        if (placeBtn) {
            const glbUrl = item.dataset.glb;
            placeBtn.addEventListener('click', async (e) => {
                const btn = e.target;
                if (btn.dataset.action === 'place') {
                    const sid = structureId != null ? structureId : (focusedStructure && focusedStructure.id);
                    // Direct placement without step-by-step visualization
                    await enableTripoPlacement(glbUrl, sid);
                    btn.textContent = 'Remove';
                    btn.dataset.action = 'remove';
                    btn.style.background = '#f44336';
                } else {
                    const sid = structureId != null ? structureId : (focusedStructure && focusedStructure.id);
                    disableTripoPlacement(sid);
                    btn.textContent = 'Place in Scene';
                    btn.dataset.action = 'place';
                    btn.style.background = '#4CAF50';
                }
            });
        }
    });
}

function appendGalleryImage(label, dataUrl, structureId) {
    const gallery = document.getElementById('captureGallery');
    if (!gallery) return;
    const item = document.createElement('div');
    item.className = 'capture-item';
    item.dataset.type = 'image';
    item.dataset.label = label || '';
    item.dataset.src = dataUrl;
    if (structureId != null) item.dataset.structureId = String(structureId);
    const filename = makeFilename(label);
    item.innerHTML = `
        <div class="capture-header">
            <div class="capture-label">${label}</div>
            <button class="download-btn" data-filename="${filename}">Download</button>
        </div>
        <img class="capture-img" src="${dataUrl}" alt="${label}">
        <button class="capture-img-action stick-skin">Stick to structure</button>
    `;
    const btn = item.querySelector('.download-btn');
    btn.addEventListener('click', () => downloadDataURL(dataUrl, filename));
    item.querySelector('.stick-skin').addEventListener('click', async () => {
        await addSkinToFocusedStructure(dataUrl);
    });
    gallery.appendChild(item);
}

function collectVoxelsForStructure(structure) {
    const set = new Set();
    const allObjects = [...groundGrid.flat(), ...voxels];
    structure.data.forEach(voxelData => {
        const targetPos = new THREE.Vector3().fromArray(voxelData.position);
        targetPos.x = Math.round(targetPos.x);
        targetPos.y = Math.round(targetPos.y);
        targetPos.z = Math.round(targetPos.z);
        const matchingVoxel = allObjects.find(voxel => {
            const p = voxel.position;
            return Math.abs(p.x - targetPos.x) < 0.1 && Math.abs(p.y - targetPos.y) < 0.1 && Math.abs(p.z - targetPos.z) < 0.1;
        });
        if (matchingVoxel) set.add(matchingVoxel);
    });
    return set;
}

function computeBoundsForVoxelSet(voxelSet) {
    const min = new THREE.Vector3(Infinity, Infinity, Infinity);
    const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
    voxelSet.forEach(v => {
        const p = v.position;
        min.x = Math.min(min.x, Math.round(p.x));
        min.y = Math.min(min.y, Math.round(p.y));
        min.z = Math.min(min.z, Math.round(p.z));
        max.x = Math.max(max.x, Math.round(p.x));
        max.y = Math.max(max.y, Math.round(p.y));
        max.z = Math.max(max.z, Math.round(p.z));
    });
    return { min, max };
}

function createOrthoCameraToFit(bounds, width, height, orientation) {
    const aspect = width / height;
    const center = new THREE.Vector3().addVectors(bounds.min, bounds.max).multiplyScalar(0.5);
    const sizeX = Math.max(1, bounds.max.x - bounds.min.x + 1);
    const sizeY = Math.max(1, bounds.max.y - bounds.min.y + 1);
    const sizeZ = Math.max(1, bounds.max.z - bounds.min.z + 1);
    const margin = 1;

    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 2000);

    if (orientation === 'top') {
        const halfW = sizeX / 2 + margin;
        const halfH = sizeZ / 2 + margin;
        const scale = Math.max(halfH, halfW / aspect);
        camera.left = -scale * aspect;
        camera.right = scale * aspect;
        camera.top = scale;
        camera.bottom = -scale;
        camera.position.set(center.x, bounds.max.y + 50, center.z);
        camera.up.set(0, 0, -1);
        camera.lookAt(center);
    } else if (orientation === 'front') {
        const halfW = sizeX / 2 + margin;
        const halfH = sizeY / 2 + margin;
        const scale = Math.max(halfH, halfW / aspect);
        camera.left = -scale * aspect;
        camera.right = scale * aspect;
        camera.top = scale;
        camera.bottom = -scale;
        camera.position.set(center.x, center.y, bounds.max.z + 50);
        camera.up.set(0, 1, 0);
        camera.lookAt(center);
    }

    camera.updateProjectionMatrix();
    return camera;
}

// Create an oblique orthographic camera at a given elevation/azimuth that tightly fits the bounds
function createOrthoObliqueCameraToFit(bounds, width, height, elevationDeg = 30, azimuthDeg = 45) {
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 5000);

    const center = new THREE.Vector3().addVectors(bounds.min, bounds.max).multiplyScalar(0.5);
    const size = new THREE.Vector3().subVectors(bounds.max, bounds.min);
    const radius = Math.max(1, size.length() * 0.5);

    const elev = THREE.MathUtils.degToRad(elevationDeg);
    const az = THREE.MathUtils.degToRad(azimuthDeg);

    // Position camera using same convention as the viewer (front-facing iso)
    const distance = radius * 4;
    const px = center.x + distance * Math.cos(elev) * Math.cos(az);
    const py = center.y + distance * Math.sin(elev);
    const pz = center.z + distance * Math.cos(elev) * Math.sin(az);
    camera.position.set(px, py, pz);

    // Derive forward direction and a robust up vector
    const dir = center.clone().sub(camera.position).normalize();
    const worldUp = new THREE.Vector3(0, 1, 0);
    const initialUp = Math.abs(worldUp.dot(dir)) > 0.99 ? new THREE.Vector3(0, 0, 1) : worldUp.clone();
    camera.up.copy(initialUp);
    camera.lookAt(center);

    // Keep upright orientation
    if (camera.up.dot(worldUp) < 0) {
        camera.up.negate();
        camera.lookAt(center);
    }

    camera.updateMatrixWorld(true);

    // Transform the 8 corners into view space to compute tight x/y extents and depth range
    const inv = new THREE.Matrix4().copy(camera.matrixWorld).invert();
    const corners = [];
    for (let xi of [bounds.min.x, bounds.max.x]) {
        for (let yi of [bounds.min.y, bounds.max.y]) {
            for (let zi of [bounds.min.z, bounds.max.z]) {
                corners.push(new THREE.Vector3(xi, yi, zi));
            }
        }
    }

    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;
    let minZ = Infinity, maxZ = -Infinity;
    for (const c of corners) {
        const v = c.clone().applyMatrix4(inv);
        minX = Math.min(minX, v.x); maxX = Math.max(maxX, v.x);
        minY = Math.min(minY, v.y); maxY = Math.max(maxY, v.y);
        const viewZ = -v.z; // forward distance
        minZ = Math.min(minZ, viewZ); maxZ = Math.max(maxZ, viewZ);
    }

    // Center and expand to match render aspect so the whole model fits, with margin
    const cx = (minX + maxX) * 0.5;
    const cy = (minY + maxY) * 0.5;
    const halfW0 = (maxX - minX) * 0.5;
    const halfH0 = (maxY - minY) * 0.5;
    const margin = 0.75;
    const targetAspect = width / height;

    let halfH = Math.max(halfH0 + margin, (halfW0 + margin) / targetAspect);
    let halfW = halfH * targetAspect;

    camera.left = cx - halfW;
    camera.right = cx + halfW;
    camera.bottom = cy - halfH;
    camera.top = cy + halfH;
    camera.near = Math.max(0.001, minZ - 1.0);
    camera.far = maxZ + 1.0;
    camera.updateProjectionMatrix();

    return camera;
}

function createPerspectiveCameraToFit(bounds, width, height, elevationDeg = 30, azimuthDeg = 45) {
    const aspect = width / height;
    const fov = 40;
    const camera = new THREE.PerspectiveCamera(fov, aspect, 0.1, 5000);

    const center = new THREE.Vector3().addVectors(bounds.min, bounds.max).multiplyScalar(0.5);
    const size = new THREE.Vector3().subVectors(bounds.max, bounds.min);
    const radius = Math.max(1, size.length() / 2);

    const distance = radius / Math.tan(THREE.MathUtils.degToRad(fov / 2)) + radius;
    const elev = THREE.MathUtils.degToRad(elevationDeg);
    const az = THREE.MathUtils.degToRad(azimuthDeg);

    const x = center.x + distance * Math.cos(elev) * Math.cos(az);
    const y = center.y + distance * Math.sin(elev);
    const z = center.z + distance * Math.cos(elev) * Math.sin(az);

    camera.position.set(x, y, z);
    camera.lookAt(center);
    camera.near = Math.max(0.1, distance - radius * 2);
    camera.far = distance + radius * 2;
    camera.updateProjectionMatrix();

    return camera;
}

function renderToDataURL(camera, width, height, { overrideMaterial = null, clearColor = null } = {}) {
    const target = new THREE.WebGLRenderTarget(width, height, { format: THREE.RGBAFormat, type: THREE.UnsignedByteType });

    // Force linear color for the render target where possible (support both pre- and post-r152)
    if (target.texture && 'colorSpace' in target.texture) {
        target.texture.colorSpace = THREE.LinearSRGBColorSpace;
    } else if (target.texture && 'encoding' in target.texture) {
        target.texture.encoding = THREE.LinearEncoding;
    }

    const prevTarget = renderer.getRenderTarget();
    const prevOverride = scene.overrideMaterial;
    const prevClear = renderer.getClearColor(new THREE.Color());
    const prevAlpha = renderer.getClearAlpha();
    const prevTone = renderer.toneMapping;

    // Preserve and switch to linear output for this offscreen pass
    const hadColorSpace = ('outputColorSpace' in renderer);
    const hadEncoding = ('outputEncoding' in renderer);
    let prevCS = null;
    let prevEnc = null;
    if (hadColorSpace) {
        prevCS = renderer.outputColorSpace;
        renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    } else if (hadEncoding) {
        prevEnc = renderer.outputEncoding;
        renderer.outputEncoding = THREE.LinearEncoding;
    }

    if (clearColor !== null) {
        renderer.setClearColor(clearColor, 1);
    }

    scene.overrideMaterial = overrideMaterial;

    renderer.toneMapping = THREE.NoToneMapping;
    renderer.setRenderTarget(target);
    renderer.clear();
    renderer.render(scene, camera);

    const pixels = new Uint8Array(width * height * 4);
    renderer.readRenderTargetPixels(target, 0, 0, width, height, pixels);

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    const imageData = ctx.createImageData(width, height);

    // Flip Y when copying
    for (let y = 0; y < height; y++) {
        const srcStart = (height - 1 - y) * width * 4;
        const destStart = y * width * 4;
        imageData.data.set(pixels.subarray(srcStart, srcStart + width * 4), destStart);
    }

    ctx.putImageData(imageData, 0, 0);

    // Restore
    renderer.setRenderTarget(prevTarget);
    scene.overrideMaterial = prevOverride;
    renderer.setClearColor(prevClear, prevAlpha);
    renderer.toneMapping = prevTone;
    if (hadColorSpace) {
        renderer.outputColorSpace = prevCS;
    } else if (hadEncoding) {
        renderer.outputEncoding = prevEnc;
    }

    target.dispose();

    return canvas.toDataURL('image/png');
}

function isolateForCapture(structureVoxels) {
    const toRestore = [];

    // Hide flat grid helper/plane so only segmented ground appears in capture
    scene.children.forEach(child => {
        const isGridOverlay = child.userData && (child.userData.isGridHelper || child.userData.isGridPlane);
        if (isGridOverlay && child.visible) {
            toRestore.push(child);
            child.visible = false;
        }
    });

    const all = [...groundGrid.flat(), ...voxels];
    all.forEach(v => {
        const inSet = structureVoxels.has(v);
        if (!inSet && v.visible) {
            toRestore.push(v);
            v.visible = false;
        }
        if (v.userData && v.userData.edges && v.userData.edges.visible) {
            toRestore.push(v.userData.edges);
            v.userData.edges.visible = false;
        }
    });

    // No markers here; they will be added by the capture routine after camera is set
    const markerNodes = [];

    return {
        restore() {
            toRestore.forEach(o => { o.visible = true; });
            // Remove temporary markers
            markerNodes.forEach(n => { scene.remove(n); n.geometry?.dispose?.(); });
        }
    };
}

function snapshotOriginalFocusedStructure() {
    if (!focusedStructure || focusedStructureVoxels.size === 0) return;
    originalStructureSnapshot = Array.from(focusedStructureVoxels).map(v => ({
        position: v.position.clone(),
        color: v.userData.baseColor || v.material.color.getHex(),
    }));
}

function clearBuildingInstances() {
    if (buildingInstanceGroup) {
        scene.remove(buildingInstanceGroup);
        // Dispose instance group children
        while (buildingInstanceGroup.children.length) {
            const child = buildingInstanceGroup.children.pop();
            if (child.geometry) child.geometry.dispose();
            if (child.material) child.material.dispose();
        }
    }
    buildingInstanceGroup = null;
}

function restoreOriginalFocusedStructure() {
    clearBuildingInstances();
    if (!originalStructureSnapshot) return;

    // Show original voxels
    focusedStructureVoxels.forEach(v => {
        v.visible = true;
        if (v.userData.edges) v.userData.edges.visible = true;
    });
}

function hideOriginalFocusedStructure() {
    focusedStructureVoxels.forEach(v => {
        v.visible = false;
        if (v.userData.edges) v.userData.edges.visible = false;
    });
}

// Track visibility state for each structure
const structureVisibilityStates = new Map();

function toggleStructureVisibility(structureId, button) {
    // Find the structure
    const structure = savedStructures.find(s => s.id === structureId);
    if (!structure) return;
    
    // Get current visibility state (default to true if not set)
    const currentVisibility = structureVisibilityStates.get(structureId) !== false;
    const newVisibility = !currentVisibility;
    structureVisibilityStates.set(structureId, newVisibility);
    
    // Find all voxels that belong to this structure
    const targetVoxels = [];
    structure.data.forEach(voxelData => {
        const targetPos = new THREE.Vector3().fromArray(voxelData.position);
        targetPos.x = Math.round(targetPos.x);
        targetPos.y = Math.round(targetPos.y);
        targetPos.z = Math.round(targetPos.z);
        
        // Search through all existing voxels
        const allObjects = [...groundGrid.flat(), ...voxels];
        const matchingVoxel = allObjects.find(voxel => {
            const voxelPos = voxel.position;
            return Math.round(voxelPos.x) === targetPos.x &&
                   Math.round(voxelPos.y) === targetPos.y &&
                   Math.round(voxelPos.z) === targetPos.z;
        });
        
        if (matchingVoxel) {
            targetVoxels.push(matchingVoxel);
        }
    });
    
    // Toggle visibility for all found voxels
    targetVoxels.forEach(v => {
        if (v && v.parent) {
            v.visible = newVisibility;
            if (v.userData && v.userData.edges) {
                v.userData.edges.visible = newVisibility;
            }
        }
    });
    
    // Update button appearance
    button.textContent = newVisibility ? '👁' : '👁‍🗨';
    button.style.opacity = newVisibility ? '1' : '0.5';
}

function regenerateProceduralBuilding() {
    if (!focusedStructure || focusedStructureVoxels.size === 0) return;
    clearBuildingInstances();
    hideOriginalFocusedStructure();

    const params = getBuildParams();
    const bounds = computeFocusedStructureBounds();

    buildingInstanceGroup = new THREE.Group();
    buildingInstanceGroup.userData.isProceduralBuilding = true;
    scene.add(buildingInstanceGroup);

    // Geometry and materials
    const sub = params.subdivisions;
    const unit = voxelSize / sub;
    const baseGeom = new THREE.BoxGeometry(unit, unit, unit);
    const wallMat = new THREE.MeshPhongMaterial({ color: 0x9b6a5d, emissive: 0x000000, shininess: 10 });
    const wallAltMat = new THREE.MeshPhongMaterial({ color: 0x8d5f52, emissive: 0x000000, shininess: 10 });
    const frameMat = new THREE.MeshPhongMaterial({ color: 0x5a5a5a, emissive: 0x000000 });
    const glassMat = new THREE.MeshPhysicalMaterial({ color: 0xa0c8ff, metalness: 0, roughness: 0.18, transmission: 0.6, transparent: true, opacity: 0.85 });
    const lightMat = new THREE.MeshPhongMaterial({ color: 0xfff3b0, emissive: 0xfff3b0, emissiveIntensity: 1.5 });
    const roofMat = new THREE.MeshPhongMaterial({ color: 0x333333 });

    // Per-material instanced meshes
    const wallMesh = new THREE.InstancedMesh(baseGeom, wallMat, 1e6);
    const wallAltMesh = new THREE.InstancedMesh(baseGeom, wallAltMat, 5e5);
    const frameMesh = new THREE.InstancedMesh(baseGeom, frameMat, 5e5);
    const glassMesh = new THREE.InstancedMesh(baseGeom, glassMat, 5e5);
    const lightMesh = new THREE.InstancedMesh(baseGeom, lightMat, 3e5);
    const roofMesh = new THREE.InstancedMesh(baseGeom, roofMat, 2e5);
    wallMesh.count = 0; wallAltMesh.count = 0; frameMesh.count = 0; glassMesh.count = 0; lightMesh.count = 0; roofMesh.count = 0;

    buildingInstanceGroup.add(wallMesh);
    buildingInstanceGroup.add(wallAltMesh);
    buildingInstanceGroup.add(frameMesh);
    buildingInstanceGroup.add(glassMesh);
    buildingInstanceGroup.add(lightMesh);
    buildingInstanceGroup.add(roofMesh);

    const dummy = new THREE.Object3D();

    const floorsPerSeg = params.floorsPerSegment;

    // Preserve original height exactly: total floors are (height segments * floorsPerSegment)
    const heightSegments = Math.round(bounds.max.y - bounds.min.y + 1);
    const totalFloors = heightSegments * floorsPerSeg;

    // Derive floor banding within each segment: use subgrid to split floors
    // floorBand = sub / floorsPerSeg; Each floor occupies floorBand sub-voxels in Y
    const floorBand = Math.max(1, Math.floor(sub / Math.max(1, floorsPerSeg)));

    // Exterior footprint cells and window column layout per direction
    const exteriorCells = computeExteriorCells(bounds);
    const layout = computeFacadeLayouts(bounds, sub, params);

    // Pass 1: structural shell with apertures, frames, glass/lights
    for (const cell of exteriorCells) {
        const baseWorldX = cell.x;
        const baseWorldZ = cell.z;

        for (let segY = 0; segY < heightSegments; segY++) {
            for (let floorInSeg = 0; floorInSeg < floorsPerSeg; floorInSeg++) {
                for (let sy = 0; sy < floorBand; sy++) {
                    const globalFloorIndex = segY * floorsPerSeg + floorInSeg;

                    for (let sx = 0; sx < sub; sx++) {
                        for (let sz = 0; sz < sub; sz++) {
                            const isShell = (sx === 0 || sx === sub - 1 || sz === 0 || sz === sub - 1 || sy === 0 || sy === floorBand - 1);
                            if (!isShell) continue;

                            const worldX = baseWorldX + (sx + 0.5) / sub;
                            const worldY = Math.floor(bounds.min.y) + segY + (floorInSeg * floorBand + sy + 0.5) / sub;
                            const worldZ = baseWorldZ + (sz + 0.5) / sub;

                            let face = null;
                            if (sx === 0) face = 'x-'; else if (sx === sub - 1) face = 'x+'; else if (sz === 0) face = 'z-'; else if (sz === sub - 1) face = 'z+';

                            const openResult = computeOpeningWithLayout(params, layout, face, globalFloorIndex, sx, sy, sz, sub, floorBand);

                            dummy.position.set(worldX, worldY, worldZ);
                            dummy.updateMatrix();

                            const isRoofLayer = (segY === heightSegments - 1) && (floorInSeg === floorsPerSeg - 1) && (sy === floorBand - 1);

                            if (!face) {
                                // roof/floor slab
                                if (isRoofLayer) {
                                    roofMesh.setMatrixAt(roofMesh.count++, dummy.matrix);
                                } else {
                                    wallMesh.setMatrixAt(wallMesh.count++, dummy.matrix);
                                }
                            } else if (openResult.open) {
                                const lit = openResult.lit;
                                const target = lit ? lightMesh : glassMesh;
                                target.setMatrixAt((lit ? lightMesh : glassMesh).count++, dummy.matrix);
                            } else if (openResult.frame) {
                                frameMesh.setMatrixAt(frameMesh.count++, dummy.matrix);
                            } else {
                                const alt = pseudoNoise(worldX * 19 + worldY * 7 + worldZ * 13) > 0.95;
                                (alt ? wallAltMesh : wallMesh).setMatrixAt(alt ? wallAltMesh.count++ : wallMesh.count++, dummy.matrix);
                            }
                        }
                    }
                }
            }
        }
    }

    // Pass 2: cornice band and simple roof details
    addCorniceBand(bounds, sub, heightSegments, floorsPerSeg, floorBand, frameMesh);
    addSimpleRoofDetails(bounds, sub, roofMesh, frameMesh);

    wallMesh.instanceMatrix.needsUpdate = true;
    wallAltMesh.instanceMatrix.needsUpdate = true;
    frameMesh.instanceMatrix.needsUpdate = true;
    glassMesh.instanceMatrix.needsUpdate = true;
    lightMesh.instanceMatrix.needsUpdate = true;
    roofMesh.instanceMatrix.needsUpdate = true;
}

function computeFacadeLayouts(bounds, sub, params) {
    // Calculate consistent window column spacing per facade based on width/depth
    const width = Math.round(bounds.max.x - bounds.min.x + 1);
    const depth = Math.round(bounds.max.z - bounds.min.z + 1);
    const frameThickness = 1; // in sub-voxels per segment side
    const windowW = Math.max(1, Math.min(params.windowWidthSub, Math.floor(sub / 2)));
    const gap = Math.max(1, Math.floor(sub / Math.max(2, params.windowDensity * 2)));

    function calc(length) {
        const content = sub - 2 * frameThickness; // interior width per segment
        // approximate columns per segment from density
        const perSegCols = Math.max(1, Math.floor(content / (windowW + gap)));
        return { perSegCols, windowW, gap, frameThickness };
    }
    return {
        north: calc(width),
        south: calc(width),
        east: calc(depth),
        west: calc(depth)
    };
}

function computeOpeningWithLayout(params, layout, face, globalFloorIndex, sx, sy, sz, sub, floorBand) {
    if (!face) return { open: false, frame: false, lit: false };

    const side = face === 'z-' ? 'north' : face === 'z+' ? 'south' : face === 'x-' ? 'west' : 'east';
    const conf = layout[side];

    // vertical bands within a floor band for window height
    const sill = Math.floor(0.15 * floorBand);
    const lintel = Math.floor(floorBand - Math.max(1, Math.floor((floorBand - params.windowHeightSub) / 2)));
    const withinWindowBand = sy >= sill && sy < lintel;

    // map to repeated per-segment columns using perSegCols and gap
    const cellSpan = conf.windowW + conf.gap;
    const local = face.startsWith('x') ? sz : sx; // choose lateral sub-voxel coordinate
    const offset = conf.frameThickness;
    const localContent = Math.max(0, local - offset);
    const inContent = local >= offset && local < sub - offset;

    let inWindowColumn = false;
    if (inContent) {
        const columnIndex = Math.floor(localContent / cellSpan);
        const columnStart = columnIndex * cellSpan;
        const withinWindowWidth = (localContent - columnStart) < conf.windowW;
        inWindowColumn = withinWindowWidth;
    }

    // Exactness toggles stochastic openings adherence
    const open = withinWindowBand && inWindowColumn && (pseudoNoise(globalFloorIndex * 97 + sx * 31 + sz * 13) <= params.exactShape);
    const frame = withinWindowBand && !open && (inContent && ((localContent % cellSpan === 0) || ((localContent + conf.windowW) % cellSpan === 0)));
    const lit = open && (pseudoNoise(globalFloorIndex * 131 + sx * 17 + sz * 23) > 0.6);

    // Style shaping (arched top)
    if (open && params.windowStyle === 'arched') {
        const relativeY = sy - sill;
        const height = Math.max(1, lintel - sill);
        const archTop = height;
        const center = Math.floor(sub / 2);
        const lateral = face.startsWith('x') ? sz : sx;
        const dx = Math.abs(lateral - center);
        const maxDx = Math.max(1, Math.floor(conf.windowW / 2));
        const archLimit = Math.floor(archTop - (dx / maxDx) * archTop);
        if (relativeY > archLimit) {
            return { open: false, frame: true, lit: false };
        }
    }

    return { open, frame, lit };
}

function addCorniceBand(bounds, sub, heightSegments, floorsPerSeg, floorBand, frameMesh) {
    const dummy = new THREE.Object3D();
    const { min, max } = bounds;
    const yLayer = Math.floor(min.y) + heightSegments - 1 + (floorsPerSeg * floorBand - 1) / sub;

    for (let x = Math.floor(min.x); x <= Math.floor(max.x); x++) {
        for (let z = Math.floor(min.z); z <= Math.floor(max.z); z++) {
            const atEdge = (x === Math.floor(min.x) || x === Math.floor(max.x) || z === Math.floor(min.z) || z === Math.floor(max.z));
            if (!atEdge) continue;
            for (let sx = 0; sx < sub; sx++) {
                for (let sz = 0; sz < sub; sz++) {
                    const worldX = x + (sx + 0.5) / sub;
                    const worldY = yLayer;
                    const worldZ = z + (sz + 0.5) / sub;
                    dummy.position.set(worldX, worldY, worldZ);
                    dummy.updateMatrix();
                    frameMesh.setMatrixAt(frameMesh.count++, dummy.matrix);
                }
            }
        }
    }
}

function addSimpleRoofDetails(bounds, sub, roofMesh, frameMesh) {
    const dummy = new THREE.Object3D();
    const { min, max } = bounds;
    const y = Math.floor(min.y) + Math.round(max.y - min.y + 1) - 1 + (0.9 / sub);

    // Sparse vents and AC units inside a margin
    const margin = 1;
    for (let x = Math.floor(min.x) + margin; x <= Math.floor(max.x) - margin; x++) {
        for (let z = Math.floor(min.z) + margin; z <= Math.floor(max.z) - margin; z++) {
            if (pseudoNoise(x * 31 + z * 17) > 0.98) {
                // small vent
                dummy.position.set(x + 0.5, y, z + 0.5);
                dummy.updateMatrix();
                frameMesh.setMatrixAt(frameMesh.count++, dummy.matrix);
            }
            if (pseudoNoise(x * 13 + z * 47) > 0.995) {
                // AC block (2x2 footprint)
                for (let dx = 0; dx < 2; dx++) for (let dz = 0; dz < 2; dz++) {
                    dummy.position.set(x + dx + 0.5, y, z + dz + 0.5);
                    dummy.updateMatrix();
                    roofMesh.setMatrixAt(roofMesh.count++, dummy.matrix);
                }
            }
        }
    }
}

function buildOccupancySet(voxelSet) {
    const set = new Set();
    voxelSet.forEach(v => {
        set.add(key(Math.round(v.position.x), Math.round(v.position.y), Math.round(v.position.z)));
    });
    return set;
}

function key(x, y, z) { return `${x}|${y}|${z}`; }

function isOnExterior(gx, gz, sizeX, sizeZ, occupancy, min) {
    const wx = Math.floor(min.x + gx);
    const wz = Math.floor(min.z + gz);
    // exterior if at perimeter of footprint
    const neighbors = [
        [wx + 1, wz], [wx - 1, wz], [wx, wz + 1], [wx, wz - 1]
    ];
    const here = occupancy.has(key(wx, Math.floor(min.y), wz));
    if (!here) return false;
    // If any neighbor is empty, treat as exterior
    for (const [nx, nz] of neighbors) {
        if (!occupancy.has(key(nx, Math.floor(min.y), nz))) return true;
    }
    // Single-tile footprints are also exterior
    if (sizeX <= 2 || sizeZ <= 2) return true;
    return false;
}

function pseudoNoise(n) {
    // Simple deterministic hash to [0,1]
    const x = Math.sin(n) * 43758.5453;
    return x - Math.floor(x);
}

function getBuildParams() {
    const subdivisions = parseInt(document.getElementById('voxelResolution').value, 10);
    const exactShape = parseFloat(document.getElementById('exactShape').value);
    const buildingType = document.getElementById('buildingType').value;
    const floorsPerSegment = parseInt(document.getElementById('floorsPerSegment').value, 10);
    const windowHeightSub = parseInt(document.getElementById('windowHeight').value, 10);
    const windowWidthSub = parseInt(document.getElementById('windowWidth').value, 10);
    const windowDensity = parseInt(document.getElementById('windowDensity').value, 10);
    return {
        subdivisions,
        exactShape,
        buildingType,
        floorsPerSegment,
        windowHeightSub,
        windowWidthSub,
        windowDensity
    };
}

function computeFocusedStructureBounds() {
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    focusedStructureVoxels.forEach(v => {
        const p = v.position;
        minX = Math.min(minX, Math.round(p.x));
        minY = Math.min(minY, Math.round(p.y));
        minZ = Math.min(minZ, Math.round(p.z));
        maxX = Math.max(maxX, Math.round(p.x));
        maxY = Math.max(maxY, Math.round(p.y));
        maxZ = Math.max(maxZ, Math.round(p.z));
    });
    return { min: new THREE.Vector3(minX, minY, minZ), max: new THREE.Vector3(maxX, maxY, maxZ) };
}

function computeExteriorCells(bounds) {
    const { min, max } = bounds;
    const occupancy = buildOccupancySet(focusedStructureVoxels);
    const cells = [];
    const baseY = Math.floor(min.y);
    for (let x = Math.floor(min.x); x <= Math.floor(max.x); x++) {
        for (let z = Math.floor(min.z); z <= Math.floor(max.z); z++) {
            const here = occupancy.has(key(x, baseY, z));
            if (!here) continue;
            const neighbors = [ [x+1,z], [x-1,z], [x,z+1], [x,z-1] ];
            let exterior = false;
            for (const [nx, nz] of neighbors) {
                if (!occupancy.has(key(nx, baseY, nz))) { exterior = true; break; }
            }
            if (exterior) cells.push({ x, z });
        }
    }
    return cells;
}

function generateBuildifyModel() {
    const description = document.getElementById('modelDescription').value;
    const detailLevel = document.getElementById('detailLevel').value;
    const resolution = document.getElementById('voxelResolution').value;
    const colorPalette = document.getElementById('colorPalette').value;
    const style = document.getElementById('buildStyle').value;
    const preserveStructure = document.getElementById('preserveStructure').checked;
    const smoothEdges = document.getElementById('smoothEdges').checked;
    const addDetails = document.getElementById('addDetails').checked;
    
    if (!description.trim()) {
        alert('Please enter a model description');
        return;
    }
    
    // Show progress
    const progress = document.getElementById('buildifyProgress');
    progress.style.display = 'block';
    
    // Simulate generation process
    simulateGeneration();
    
    console.log('Generating model with settings:', {
        description,
        detailLevel,
        resolution,
        colorPalette,
        style,
        preserveStructure,
        smoothEdges,
        addDetails
    });
}

function previewBuildifyModel() {
    console.log('Previewing model...');
    // TODO: Implement preview functionality
}

function resetBuildifyModel() {
    console.log('Resetting model...');
    // TODO: Implement reset functionality
}

function simulateGeneration() {
    const progressFill = document.querySelector('.progress-fill');
    const progressText = document.querySelector('.progress-text');
    let progress = 0;
    
    const interval = setInterval(() => {
        progress += Math.random() * 15;
        if (progress >= 100) {
            progress = 100;
            clearInterval(interval);
            progressText.textContent = 'Complete!';
            setTimeout(() => {
                document.getElementById('buildifyProgress').style.display = 'none';
                progressFill.style.width = '0%';
                progressText.textContent = 'Generating...';
            }, 2000);
        }
        progressFill.style.width = progress + '%';
    }, 200);
}

function updateGizmos() {
    if (shiftPressed && selectedVoxels.length > 0) {
        createGizmos();
    } else {
        hideGizmos();
    }
}

function startGizmoDrag(gizmo, event) {
    isDraggingGizmo = true;
    activeGizmo = gizmo;
    dragAxis = gizmo.userData.axis;
    dragDirection = gizmo.userData.negative ? -1 : 1;
    dragStartPos = { x: event.clientX, y: event.clientY };
    
    // Highlight the active gizmo
    const color = dragDirection > 0 ? 
        (dragAxis === 'x' ? 0xff6666 : dragAxis === 'y' ? 0x66ff66 : 0x6666ff) :
        (dragAxis === 'x' ? 0xcc4444 : dragAxis === 'y' ? 0x44cc44 : 0x4444cc);
    
    gizmo.setColor(color);
    
    createDragPreview();
}

function updateDragPreview(event) {
    clearDragPreview();
    
    // Check if dragStartPos exists
    if (!dragStartPos) return;
    
    const dragDistance = Math.abs(event.clientX - dragStartPos.x) + Math.abs(event.clientY - dragStartPos.y);
    const extendAmount = Math.max(1, Math.floor(dragDistance / 50));
    
    selectedVoxels.forEach(voxel => {
        for (let i = 1; i <= extendAmount; i++) {
            const geometry = new THREE.BoxGeometry(voxelSize, voxelSize, voxelSize);
            const edges = new THREE.EdgesGeometry(geometry);
            const line = new THREE.LineSegments(
                edges,
                new THREE.LineDashedMaterial({
                    color: 0x00ffff,
                    dashSize: 0.3,
                    gapSize: 0.2,
                    linewidth: 2
                })
            );
            
            const position = voxel.position.clone();
            if (dragAxis === 'y') {
                position.y = Math.round(position.y + dragDirection * i * voxelSize);
            } else if (dragAxis === 'x') {
                position.x = Math.round(position.x + dragDirection * i * voxelSize);
            } else if (dragAxis === 'z') {
                position.z = Math.round(position.z + dragDirection * i * voxelSize);
            }
            
            line.position.copy(position);
            line.computeLineDistances();
            previewGroup.add(line);
        }
    });
}

function clearDragPreview() {
    while(previewGroup.children.length > 0) {
        previewGroup.remove(previewGroup.children[0]);
    }
}

function createDragPreview() {
    clearDragPreview();
}

function finishGizmoDrag() {
    if (!isDraggingGizmo) return;
    
    const container = document.getElementById('scene-container');
    const rect = container.getBoundingClientRect();
    
    const dragDistance = Math.abs(event.clientX - dragStartPos.x) + Math.abs(event.clientY - dragStartPos.y);
    const extendAmount = Math.max(1, Math.floor(dragDistance / 50));
    
    const newVoxels = [];
    
    selectedVoxels.forEach(voxel => {
        for (let i = 1; i <= extendAmount; i++) {
            const geometry = new THREE.BoxGeometry(voxelSize, voxelSize, voxelSize);
            const baseColor = voxel.userData.baseColor || new THREE.Color().setHSL(Math.random(), 0.5, 0.6).getHex();
            const material = new THREE.MeshPhongMaterial({ 
                color: baseColor,
                emissive: 0x000000,
                emissiveIntensity: 0
            });
            const cube = new THREE.Mesh(geometry, material);
            
            const position = voxel.position.clone();
            if (dragAxis === 'y') {
                position.y = Math.round(position.y + dragDirection * i * voxelSize);
            } else if (dragAxis === 'x') {
                position.x = Math.round(position.x + dragDirection * i * voxelSize);
            } else if (dragAxis === 'z') {
                position.z = Math.round(position.z + dragDirection * i * voxelSize);
            }
            
            cube.position.copy(position);
            cube.userData = { 
                type: 'voxel',
                selected: false,
                baseColor: baseColor
            };
            
            // Add edge highlights
            const edges = new THREE.EdgesGeometry(geometry);
            const edgeMaterial = new THREE.LineBasicMaterial({ color: 0x000000, linewidth: 1 });
            const edgeLines = new THREE.LineSegments(edges, edgeMaterial);
            edgeLines.position.copy(cube.position);
            cube.userData.edges = edgeLines;
            scene.add(edgeLines);
            
            // Apply height-based coloring
            updateVoxelColor(cube);
            
            cube.castShadow = true;
            cube.receiveShadow = true;
            
            scene.add(cube);
            voxels.push(cube);
            newVoxels.push(cube);
            
            // Add to focused structure if in focus mode
            addVoxelToFocusedStructure(cube);
        }
    });
    
    clearDragPreview();
    clearSelection();
    newVoxels.forEach(voxel => toggleSelection(voxel));
    
    // Only show gizmos if shift is still pressed
    if (shiftPressed && selectedVoxels.length > 0) {
        createGizmos();
    } else {
        hideGizmos();
    }
    
    // Reset gizmo color
    if (activeGizmo) {
        const originalColor = dragDirection > 0 ? 
            (dragAxis === 'x' ? 0xff0000 : dragAxis === 'y' ? 0x00ff00 : 0x0000ff) :
            (dragAxis === 'x' ? 0x880000 : dragAxis === 'y' ? 0x008800 : 0x000088);
        activeGizmo.setColor(originalColor);
    }
    
    isDraggingGizmo = false;
    activeGizmo = null;
    dragAxis = null;
    dragStartPos = null;
}

function saveSelectedStructure() {
    if (selectedVoxels.length === 0) {
        alert('No voxels selected!');
        return;
    }
    
    const structureData = selectedVoxels.map(voxel => ({
        position: voxel.position.toArray(),
        color: voxel.material.color.getHex(),
        size: voxelSize
    }));
    
    const structure = {
        id: Date.now(),
        name: `Structure ${savedStructures.length + 1}`,
        data: structureData,
        thumbnail: null
    };
    
    savedStructures.push(structure);
    updateStructuresMenu();
    clearSelection();
    
    ipcRenderer.invoke('save-structure', structure);
}

function updateStructuresMenu() {
    const list = document.getElementById('structures-list');
    list.innerHTML = '';
    
    savedStructures.forEach(structure => {
        const item = document.createElement('div');
        item.className = 'structure-item';
        const hasSkins = (structureIdToSkinUrls.get(structure.id)?.length || 0) > 0;
        item.innerHTML = `
            <div class="structure-preview" style="position:relative;"></div>
            <div class="structure-name" style="display:flex; align-items:center; justify-content:space-between; gap:8px;">
                <span>${structure.name}</span>
                <div style="display:flex; gap:4px;">
                    <button class="structure-visibility" title="Toggle Visibility" style="font-size:12px; padding:2px 6px;">👁</button>
                    <button class="structure-delete" title="Delete" style="font-size:12px; padding:2px 6px;">🗑</button>
                </div>
            </div>
            <div class="skin-controls">
                <button class="skin-btn skin-left">◀</button>
                <button class="skin-btn skin-adjust">🎯</button>
                <button class="skin-btn skin-right">▶</button>
            </div>
        `;
        item.addEventListener('click', () => loadStructure(structure));
        
        // Visibility button
        const visBtn = item.querySelector('.structure-visibility');
        visBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleStructureVisibility(structure.id, visBtn);
        });
        
        // Skin buttons
        const left = item.querySelector('.skin-left');
        const right = item.querySelector('.skin-right');
        const adjust = item.querySelector('.skin-adjust');
        left.addEventListener('click', (e) => { e.stopPropagation(); cycleSkin(structure.id, -1); persistStateIfEnabled(); });
        right.addEventListener('click', (e) => { e.stopPropagation(); cycleSkin(structure.id, +1); persistStateIfEnabled(); });
        adjust.addEventListener('click', (e) => {
            e.stopPropagation(); toggleSkinAdjust(structure.id, adjust);
        });
        const delBtn = item.querySelector('.structure-delete');
        delBtn.addEventListener('click', (e) => { e.stopPropagation(); deleteStructureById(structure.id); });
        list.appendChild(item);
    });
    persistStateIfEnabled();
}

function transitionFocusModeToNewStructure(structure) {
    console.log(`Transitioning focus mode from structure ${focusedStructure.id} to ${structure.id}`);
    
    // Detach transform controls from current model
    detachTripoTransformControls();
    
    // Clear current active model references
    tripoModelGroup = null;
    tripoPlacementEnabled = false;
    
    // Update the focused structure voxels set with new structure voxels
    focusedStructureVoxels.clear();
    
    // Find all voxels that belong to the new focused structure
    structure.data.forEach(voxelData => {
        const targetPos = new THREE.Vector3().fromArray(voxelData.position);
        targetPos.x = Math.round(targetPos.x);
        targetPos.y = Math.round(targetPos.y);
        targetPos.z = Math.round(targetPos.z);
        
        const allObjects = [...groundGrid.flat(), ...voxels];
        const matchingVoxel = allObjects.find(voxel => {
            const voxelPos = voxel.position;
            return Math.abs(voxelPos.x - targetPos.x) < 0.1 && 
                   Math.abs(voxelPos.y - targetPos.y) < 0.1 && 
                   Math.abs(voxelPos.z - targetPos.z) < 0.1;
        });
        
        if (matchingVoxel) {
            focusedStructureVoxels.add(matchingVoxel);
        }
    });
    
    // Update focus mode visibility for all voxels and models
    updateFocusModeVisibility();
    
    // Check if the new structure has a model and activate it
    const modelData = placedModelsByStructure.get(structure.id);
    if (modelData && modelData.group) {
        tripoModelGroup = modelData.group;
        tripoPlacementEnabled = true;
        attachTripoTransformControls(tripoModelGroup);
    }
}

function loadStructure(structure) {
    // Save current gallery state before switching
    saveCurrentGalleryState();
    
    clearSelection();
    
    // Set this as the focused structure (for potential focus mode)
    focusedStructure = structure;
    
    // Load the gallery for this structure
    loadGalleryForStructure(structure.id);
    
    // Find existing voxels that match the saved structure positions
    structure.data.forEach(voxelData => {
        const targetPos = new THREE.Vector3().fromArray(voxelData.position);
        targetPos.x = Math.round(targetPos.x);
        targetPos.y = Math.round(targetPos.y);
        targetPos.z = Math.round(targetPos.z);
        
        // Search through all existing voxels (ground grid and created voxels)
        const allObjects = [...groundGrid.flat(), ...voxels];
        const matchingVoxel = allObjects.find(voxel => {
            const voxelPos = voxel.position;
            return Math.abs(voxelPos.x - targetPos.x) < 0.1 && 
                   Math.abs(voxelPos.y - targetPos.y) < 0.1 && 
                   Math.abs(voxelPos.z - targetPos.z) < 0.1;
        });
        
        if (matchingVoxel) {
            toggleSelection(matchingVoxel);
        }
    });
    
    // Update gizmos if shift is pressed
    if (shiftPressed && selectedVoxels.length > 0) {
        createGizmos();
    }
    // When loading a structure, apply its active skin if any
    applyActiveSkinForFocusedStructure();
    
    // If we're in focus mode, transition to the new structure's focus mode
    if (focusMode) {
        transitionFocusModeToNewStructure(structure);
    }
}

function onWindowResize() {
    const container = document.getElementById('scene-container');
    const aspect = container.clientWidth / container.clientHeight;
    const frustumSize = 30;
    
    camera.left = frustumSize * aspect / -2;
    camera.right = frustumSize * aspect / 2;
    camera.top = frustumSize / 2;
    camera.bottom = frustumSize / -2;
    camera.updateProjectionMatrix();
    
    renderer.setSize(container.clientWidth, container.clientHeight);
    updateScreenOverlayTransform();
}

function animate() {
    requestAnimationFrame(animate);
    renderer.render(scene, camera);
    updateScreenOverlayVisibility();
    updateScreenOverlayTransform();

    // Update axis indicator orientation
    if (axisCamera && axisRenderer) {
        axisCamera.quaternion.copy(camera.quaternion);
        axisRenderer.render(axisScene, axisCamera);
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}

function createLinearDepthMaterial(nearZ, farZ, invert = false, gamma = 1.0, steps = 0) {
    return new THREE.ShaderMaterial({
        uniforms: {
            nearZ: { value: nearZ },
            farZ: { value: Math.max(nearZ + 1e-6, farZ) },
            invert: { value: invert ? 1.0 : 0.0 },
            gamma: { value: Math.max(1e-6, gamma) },
            steps: { value: Math.max(0.0, steps) }
        },
        vertexShader: `
            varying float vViewZ;
            void main() {
                vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
                vViewZ = -mvPosition.z; // view-space forward distance
                gl_Position = projectionMatrix * mvPosition;
            }
        `,
        fragmentShader: `
            precision highp float;
            varying float vViewZ;
            uniform float nearZ;
            uniform float farZ;
            uniform float invert;
            uniform float gamma;
            uniform float steps;
            void main() {
                float d = clamp((vViewZ - nearZ) / (farZ - nearZ), 0.0, 1.0);
                // optional inversion so near is white
                d = mix(d, 1.0 - d, step(0.5, invert));
                // optional quantization to steps (clamped to [0,1])
                if (steps > 0.5) {
                    float denom = max(1.0, steps - 1.0);
                    d = floor(d * denom + 0.00001) / denom;
                }
                // gamma shaping (1.0 = linear)
                d = pow(d, gamma);
                gl_FragColor = vec4(vec3(clamp(d, 0.0, 1.0)), 1.0);
            }
        `,
        depthTest: true,
        depthWrite: true
    });
}

function computeDepthRangeForSet(voxelSet, cameraForDepth) {
    cameraForDepth.updateMatrixWorld(true);
    const viewMatrix = cameraForDepth.matrixWorldInverse.clone();

    // Sample 8 corners of each voxel instead of its center for robust near/far
    const half = voxelSize * 0.5;
    const offsets = [
        new THREE.Vector3(-half, -half, -half), new THREE.Vector3(half, -half, -half),
        new THREE.Vector3(-half, half, -half),  new THREE.Vector3(half, half, -half),
        new THREE.Vector3(-half, -half, half),  new THREE.Vector3(half, -half, half),
        new THREE.Vector3(-half, half, half),   new THREE.Vector3(half, half, half)
    ];

    let minZ = Infinity;
    let maxZ = -Infinity;
    voxelSet.forEach(v => {
        const base = v.position;
        for (let i = 0; i < offsets.length; i++) {
            const corner = base.clone().add(offsets[i]);
            const vp = corner.applyMatrix4(viewMatrix); // camera/view space
            const viewZ = -vp.z; // forward distance
            minZ = Math.min(minZ, viewZ);
            maxZ = Math.max(maxZ, viewZ);
        }
    });

    // Add a small margin to avoid clipping to 0/1
    const margin = Math.max(0.01, (maxZ - minZ) * 0.02);
    return { nearZ: Math.max(0.001, minZ - margin), farZ: maxZ + margin };
}

function snapSceneCameraToDefaultIso() {
    // Restore the exact initial camera state used at app load
    const container = document.getElementById('scene-container');
    const width = container.clientWidth || renderer.domElement.width;
    const height = container.clientHeight || renderer.domElement.height;
    const aspect = width / height;

    currentZoom = 1; // initial zoom
    const frustumSize = 30; // initial frustum size
    camera.left = (frustumSize * aspect) / -2;
    camera.right = (frustumSize * aspect) / 2;
    camera.top = frustumSize / 2;
    camera.bottom = frustumSize / -2;
    camera.near = 0.1;
    camera.far = 1000;

    camera.position.set(20, 20, 20); // initial position
    camera.up.set(0, 1, 0);
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
}

// Compose side-by-side color and depth renders with labels
async function renderSplitColorDepth(voxelSet, camera, width, height, leftLabel) {
    const halfW = Math.floor(width / 2);

    // Normal render (left)
    const colorUrl = renderToDataURL(camera, halfW, height, { clearColor: 0xffffff });

    // Depth render (right)
    const { nearZ, farZ } = computeDepthRangeForSet(voxelSet, camera);
    const depthMat = createLinearDepthMaterial(nearZ, farZ, true, 1.0, 32);
    const depthUrl = renderToDataURL(camera, halfW, height, { overrideMaterial: depthMat, clearColor: 0x000000 });
    depthMat.dispose();

    const [colorImg, depthImg] = await Promise.all([
        loadImageFromDataURL(colorUrl),
        loadImageFromDataURL(depthUrl)
    ]);

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');

    // Draw images
    ctx.drawImage(colorImg, 0, 0, halfW, height);
    ctx.drawImage(depthImg, halfW, 0, halfW, height);

    // Overlay headers
    const headerH = 28;
    ctx.fillStyle = 'rgba(0,0,0,0.75)';
    ctx.fillRect(0, 0, halfW, headerH);
    ctx.fillRect(halfW, 0, halfW, headerH);

    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 12px -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Oxygen, Ubuntu, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.fillText(leftLabel.toUpperCase(), 10, Math.floor(headerH / 2));
    ctx.fillText('DEPTH', halfW + 10, Math.floor(headerH / 2));

    return canvas.toDataURL('image/png');
}

function loadImageFromDataURL(url) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = url;
    });
}

function downloadDataURL(dataUrl, filename) {
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = filename || 'image.png';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
}

function makeFilename(label) {
    const base = String(label || 'image').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    const ts = new Date().toISOString().slice(0,19).replace(/[:T-]/g, '');
    return `${base}_${ts}.png`;
}

function expandOrthoFrustum(cam, scale = 1.05) {
    if (!(cam && 'left' in cam && 'right' in cam && 'top' in cam && 'bottom' in cam)) return;
    const cx = (cam.left + cam.right) * 0.5;
    const cy = (cam.top + cam.bottom) * 0.5;
    const halfW = (cam.right - cam.left) * 0.5 * scale;
    const halfH = (cam.top - cam.bottom) * 0.5 * scale;
    cam.left = cx - halfW;
    cam.right = cx + halfW;
    cam.bottom = cy - halfH;
    cam.top = cy + halfH;
    cam.updateProjectionMatrix();
}

// Capture a fresh isometric color image, upload it to obtain a public URL, and call FLUX Depth API
async function sendIsometricToFalDepth() {
    await ensureEnvLoaded();
    if (!focusedStructure) {
        showToast('Load a saved structure first', 'error');
        debugLog('send-flux:error:no-structure');
        return;
    }

    // Capture the source structure ID at the start to prevent race conditions
    const sourceStructureId = focusedStructure.id;

    // Use the latest captured image instead of taking a new snapshot
    if (!latestCapturedImageUrl) {
        showToast('Please capture structure first', 'error');
        return;
    }

    const colorUrl = latestCapturedImageUrl;

    const apiKey = (window.FAL_KEY || localStorage.getItem('FAL_KEY'));
    if (!apiKey) {
        alert('Set your FAL_KEY first. Store it in localStorage under key "FAL_KEY" (localStorage.setItem("FAL_KEY", "YOUR_KEY")) and try again.');
        return;
    }

    // Read prompt from UI
    const promptInput = document.getElementById('falPromptInput');
    const prompt = (promptInput && promptInput.value?.trim()) || 'High-quality render guided by isometric depth';

    // Read extra parameters from UI
    const p = {
        image_size: (document.getElementById('falSize')?.value) || 'landscape_4_3',
        num_inference_steps: parseInt(document.getElementById('falSteps')?.value || '28', 10),
        guidance_scale: parseFloat(document.getElementById('falGuidance')?.value || '3.5'),
        seed: (document.getElementById('falSeed')?.value ? parseInt(document.getElementById('falSeed').value, 10) : undefined),
        num_images: parseInt(document.getElementById('falNum')?.value || '1', 10),
        output_format: (document.getElementById('falFormat')?.value) || 'jpeg',
        safety_tolerance: (document.getElementById('falSafety')?.value) || '2',
        sync_mode: !!(document.getElementById('falSync')?.checked)
    };
    // Seed lock: reuse last returned seed if checkbox present and enabled
    const seedLockEl = document.getElementById('falSeedLock');
    if (seedLockEl && seedLockEl.checked && lastFalSeed != null) {
        p.seed = lastFalSeed;
    }

    // Attempt 1: send data URL directly
    const firstAttempt = await callFalDepth(apiKey, prompt, colorUrl, p);
    if (firstAttempt) { debugLog('send-flux:direct:ok', { url: firstAttempt }); attachFalResult(firstAttempt, sourceStructureId); return; }
    debugLog('send-flux:direct:miss');
    const uploadedUrl = await uploadViaFalClient(colorUrl);
    if (uploadedUrl) {
        debugLog('send-flux:uploaded', { uploadedUrl });
        const secondAttempt = await callFalDepth(apiKey, prompt, uploadedUrl, p);
        if (secondAttempt) { debugLog('send-flux:upload:ok', { url: secondAttempt }); attachFalResult(secondAttempt, sourceStructureId); return; }
        debugLog('send-flux:upload:miss');
    }
    const imgurUrl = await uploadImageDataURL_viaImgurOnly(colorUrl);
    if (imgurUrl) {
        debugLog('send-flux:imgur', { imgurUrl });
        const thirdAttempt = await callFalDepth(apiKey, prompt, imgurUrl, p);
        if (thirdAttempt) { debugLog('send-flux:imgur:ok', { url: thirdAttempt }); attachFalResult(thirdAttempt, sourceStructureId); return; }
        debugLog('send-flux:imgur:miss');
    }
    window.open(colorUrl, '_blank');
    showToast('Could not auto-send image. Opened in new tab.', 'error');
    debugLog('send-flux:fallback-open');
}

async function callFalDepth(apiKey, prompt, controlImage, extraParams = {}) {
    try {
        const res = await fetch('https://fal.run/fal-ai/flux-pro/v1/depth', {
            method: 'POST',
            headers: {
                'Authorization': `Key ${apiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                prompt,
                control_image_url: controlImage,
                image_size: extraParams.image_size ?? 'landscape_4_3',
                num_inference_steps: extraParams.num_inference_steps ?? 28,
                guidance_scale: extraParams.guidance_scale ?? 3.5,
                num_images: extraParams.num_images ?? 1,
                output_format: extraParams.output_format ?? 'jpeg',
                safety_tolerance: extraParams.safety_tolerance ?? '2',
                seed: extraParams.seed,
                sync_mode: extraParams.sync_mode ?? false
            })
        });
        if (!res.ok) return null;
        const data = await res.json();
        try { if (typeof data?.seed === 'number') { lastFalSeed = data.seed; debugLog('send-flux:seed', { seed: lastFalSeed }); } } catch {}
        const first = data && data.images && data.images[0] && data.images[0].url;
        return first || null;
    } catch (e) {
        console.warn('fal depth call failed:', e);
        return null;
    }
}

function attachFalResult(imageUrl, sourceStructureId = null) {
    const item = document.createElement('div');
    item.className = 'capture-item';
    item.dataset.type = 'flux';
    item.dataset.src = imageUrl;
    const structureId = sourceStructureId || (focusedStructure && focusedStructure.id);
    if (structureId != null) item.dataset.structureId = String(structureId);
    item.innerHTML = `
        <div class="capture-header">
            <div class="capture-label">FLUX DEPTH RESULT</div>
            <button class="download-btn">Download</button>
        </div>
        <img class="capture-img" src="${imageUrl}" alt="FLUX Depth Result">
        <div class="capture-actions">
            <button class="send-tripo-btn">SEND TO TRIPO</button>
            <button class="capture-img-action stick-skin">Stick to structure</button>
        </div>
    `;
    item.querySelector('.download-btn').addEventListener('click', async () => {
        downloadDataURL(imageUrl, makeFilename('flux_depth_result'));
    });
    const sendBtn = item.querySelector('.send-tripo-btn');
    sendBtn.addEventListener('click', async () => {
        sendBtn.disabled = true;
        sendBtn.textContent = 'Sending...';
        try {
            showToast('Sending to Tripo…', 'info');
            await sendImageToTripo(imageUrl);
            sendBtn.textContent = 'Sent';
            showToast('Sent to Tripo', 'success');
        } catch (e) {
            console.error('Tripo send failed:', e);
            showToast('Tripo send failed', 'error');
            sendBtn.textContent = 'SEND TO TRIPO';
            sendBtn.disabled = false;
        }
    });
    // Stick to structure (as skin)
    item.querySelector('.stick-skin').addEventListener('click', async () => {
        showToast('Preparing skin…', 'info');
        await addSkinToFocusedStructure(imageUrl);
    });
    // Add to the correct structure's gallery
    if (structureId != null) {
        // If this is the currently focused structure, add to visible gallery and save state
        if (focusedStructure && focusedStructure.id === structureId) {
            const gallery = document.getElementById('captureGallery');
            gallery && gallery.prepend(item);
            saveCurrentGalleryState();
        } else {
            // Add to the structure's stored gallery HTML
            addItemToStructureGallery(item, structureId);
        }
    } else {
        // Fallback to current gallery if no structure ID
        const gallery = document.getElementById('captureGallery');
        gallery && gallery.prepend(item);
        saveCurrentGalleryState();
    }
    persistStateIfEnabled();
}

async function uploadImageDataURL(dataUrl) {
    try {
        // Preferred: upload directly to fal storage using FAL_KEY (no external hosting key required)
        const uploaded = await uploadViaFalClient(dataUrl);
        if (uploaded) return uploaded;
    } catch (e) {
        console.warn('fal storage upload failed:', e);
    }
    try {
        // Prefer Imgur anonymous upload if client ID provided
        await ensureEnvLoaded();
        const imgurClientId = window.IMGUR_CLIENT_ID || localStorage.getItem('IMGUR_CLIENT_ID');
        if (imgurClientId) {
            const base64 = dataUrl.split(',')[1];
            const r = await fetch('https://api.imgur.com/3/image', {
                method: 'POST',
                headers: { Authorization: `Client-ID ${imgurClientId}` },
                body: new URLSearchParams({ image: base64, type: 'base64' })
            });
            const j = await r.json();
            if (j && j.data && j.data.link) return j.data.link;
        }
    } catch (e) {
        console.warn('Imgur upload failed:', e);
    }
    return null;
}

// Imgur-only branch so caller can explicitly try it as a later fallback
async function uploadImageDataURL_viaImgurOnly(dataUrl) {
    try {
        await ensureEnvLoaded();
        const imgurClientId = window.IMGUR_CLIENT_ID || localStorage.getItem('IMGUR_CLIENT_ID');
        if (!imgurClientId) return null;
        const base64 = dataUrl.split(',')[1];
        const r = await fetch('https://api.imgur.com/3/image', {
            method: 'POST',
            headers: { Authorization: `Client-ID ${imgurClientId}` },
            body: new URLSearchParams({ image: base64, type: 'base64' })
        });
        const j = await r.json();
        if (j && j.data && j.data.link) return j.data.link;
    } catch (e) {
        console.warn('Imgur upload failed:', e);
    }
    return null;
}

async function uploadViaFalClient(dataUrl) {
    await ensureEnvLoaded();
    const apiKey = window.FAL_KEY || localStorage.getItem('FAL_KEY');
    if (!apiKey) return null;
    const toBlob = await (await fetch(dataUrl)).blob();
    try {
        let fal;
        try {
            const mod = await import('https://esm.sh/@fal-ai/client');
            fal = mod.fal || mod.default?.fal || mod;
        } catch (_) {
            const mod2 = await import('https://cdn.jsdelivr.net/npm/@fal-ai/client/+esm');
            fal = mod2.fal || mod2.default?.fal || mod2;
        }
        if (fal?.config) {
            try { fal.config({ credentials: apiKey }); } catch {}
        }
        if (fal?.storage?.upload) {
            const url = await fal.storage.upload(toBlob);
            return url || null;
        }
    } catch (e) {
        console.warn('Failed to import/use @fal-ai/client:', e);
    }
    return null;
}

// Load environment variables from '/.env' and '/.env.local' if available
async function ensureEnvLoaded() {
    if (__envLoaded) return;
    // 1) process.env (Electron/Node with nodeIntegration)
    try {
        // eslint-disable-next-line no-undef
        if (typeof process !== 'undefined' && process?.env) {
            applyEnvVars(process.env);
        }
    } catch {}
    // 2) Try common paths
    const candidates = [
        '/.env', '/.env.local', './.env', './.env.local',
        (() => { try { return new URL('.env', window.location.href).toString(); } catch { return null; } })(),
        (() => { try { return new URL('.env.local', window.location.href).toString(); } catch { return null; } })()
    ].filter(Boolean);
    for (const p of candidates) {
        try { await loadEnvFile(p); } catch {}
    }
    __envLoaded = true;
    if (!window.FAL_KEY && !localStorage.getItem('FAL_KEY')) {
        console.warn('[ENV] FAL_KEY not found after loading .env; set FAL_KEY in .env or localStorage.');
    } else {
        console.log('[ENV] FAL_KEY loaded.');
    }
}

async function loadEnvFile(path) {
    const res = await fetch(path, { cache: 'no-store' });
    if (!res.ok) return;
    const text = await res.text();
    const vars = parseDotenv(text);
    applyEnvVars(vars);
}

function parseDotenv(text) {
    const out = {};
    text.split(/\r?\n/).forEach(line => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) return;
        const eq = trimmed.indexOf('=');
        if (eq === -1) return;
        const key = trimmed.slice(0, eq).trim();
        let val = trimmed.slice(eq + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith('\'') && val.endsWith('\''))) {
            val = val.slice(1, -1);
        }
        out[key] = val;
    });
    return out;
}

function applyEnvVars(vars) {
    if (!vars) return;
    if (vars.FAL_KEY) {
        window.FAL_KEY = vars.FAL_KEY;
        // Also persist for subsequent sessions
        try { localStorage.setItem('FAL_KEY', vars.FAL_KEY); } catch {}
    }
    if (vars.IMGUR_CLIENT_ID) {
        window.IMGUR_CLIENT_ID = vars.IMGUR_CLIENT_ID;
        try { localStorage.setItem('IMGUR_CLIENT_ID', vars.IMGUR_CLIENT_ID); } catch {}
    }
}

async function sendImageToTripo(imageUrl) {
    await ensureEnvLoaded();
    const apiKey = window.FAL_KEY || localStorage.getItem('FAL_KEY');
    if (!apiKey) {
        showToast('FAL_KEY not set', 'error');
        return;
    }
    const sourceStructureId = focusedStructure ? focusedStructure.id : null;
    // Try direct REST first
    let data = null;
    try {
        const res = await fetch('https://fal.run/tripo3d/tripo/v2.5/image-to-3d', {
            method: 'POST',
            headers: {
                'Authorization': `Key ${apiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ image_url: imageUrl, texture: 'standard', texture_alignment: 'original_image', orientation: 'align_image', auto_size: true })
        });
        if (res.ok) {
            data = await res.json();
        }
    } catch (e) {
        console.warn('Direct Tripo call failed, will try client:', e);
    }
    // Fallback to client subscribe to wait if needed
    if (!data || !data.model_mesh || !data.model_mesh.url) {
        try {
            let fal;
            try {
                const mod = await import('https://esm.sh/@fal-ai/client');
                fal = mod.fal || mod.default?.fal || mod;
            } catch (_) {
                const mod2 = await import('https://cdn.jsdelivr.net/npm/@fal-ai/client/+esm');
                fal = mod2.fal || mod2.default?.fal || mod2;
            }
            if (fal?.config) { try { fal.config({ credentials: apiKey }); } catch {} }
            const result = await fal.subscribe('tripo3d/tripo/v2.5/image-to-3d', {
                input: { image_url: imageUrl, texture: 'standard', texture_alignment: 'original_image', orientation: 'align_image', auto_size: true },
                logs: true
            });
            data = result?.data || result;
        } catch (e) {
            console.error('Tripo client subscribe failed:', e);
            throw e;
        }
    }

    if (!data || !data.model_mesh || !data.model_mesh.url) {
        throw new Error('Tripo response missing model mesh URL');
    }
    attachTripoResult(data.model_mesh.url, data.rendered_image && data.rendered_image.url, sourceStructureId);
}

function attachTripoResult(glbUrl, previewUrl, sourceStructureId = null) {
    // If a card with this GLB already exists, do not add another
    const dup = document.querySelector(`.capture-item[data-type="tripo"][data-glb="${glbUrl}"]`);
    if (dup) return dup;

    const gallery = document.getElementById('captureGallery');
    const item = document.createElement('div');
    item.className = 'capture-item';
    item.dataset.type = 'tripo';
    item.dataset.glb = glbUrl;
    if (sourceStructureId != null) item.dataset.structureId = String(sourceStructureId);
    const fileName = makeFilename('tripo_model');
    item.innerHTML = `
        <div class="capture-header">
            <div class="capture-label">TRIPO 3D RESULT</div>
            <button class="download-btn">Download GLB</button>
        </div>
        <div class="tripo-viewer" style="height: 320px; background: #f6f6f6; border: 1px solid #e6e6e6; border-radius: 4px;"></div>
        <div class="capture-actions" style="margin-top: 8px; display: flex; align-items: center; gap: 12px;">
            <button class="place-remove-btn" data-action="place" style="padding: 6px 12px; background: #4CAF50; color: white; border: none; border-radius: 4px; cursor: pointer;">
                Place in Scene
            </button>
        </div>
    `;
    item.querySelector('.download-btn').addEventListener('click', async () => {
        const a = document.createElement('a');
        a.href = glbUrl; a.download = fileName.replace(/\.png$/, '.glb');
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
    });
    
    // Add to the correct structure's gallery
    const structureId = sourceStructureId || (focusedStructure && focusedStructure.id);
    if (structureId != null) {
        // If this is the currently focused structure, add to visible gallery and save state
        if (focusedStructure && focusedStructure.id === structureId) {
            gallery && gallery.prepend(item);
            saveCurrentGalleryState();
        } else {
            // Add to the structure's stored gallery HTML
            addItemToStructureGallery(item, structureId);
        }
    } else {
        // Fallback to current gallery if no structure ID
        gallery && gallery.prepend(item);
        saveCurrentGalleryState();
    }
    
    const container = item.querySelector('.tripo-viewer');
    initTripoViewer(container, glbUrl);
    const placeBtn = item.querySelector('.place-remove-btn');
    placeBtn.addEventListener('click', async (e) => {
        const btn = e.target;
        if (btn.dataset.action === 'place') {
            // Direct placement without step-by-step visualization
            await enableTripoPlacement(glbUrl, sourceStructureId || (focusedStructure && focusedStructure.id));
            btn.textContent = 'Remove';
            btn.dataset.action = 'remove';
            btn.style.background = '#f44336';
        } else {
            disableTripoPlacement(sourceStructureId || (focusedStructure && focusedStructure.id));
            btn.textContent = 'Place in Scene';
            btn.dataset.action = 'place';
            btn.style.background = '#4CAF50';
        }
    });
    const toolButtons = item.querySelectorAll('.tripo-tools .buildify-btn');
    toolButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            if (!tripoTransformControls) return;
            tripoTransformControls.setMode(btn.getAttribute('data-mode'));
        });
    });
    persistStateIfEnabled();
}

async function initTripoViewer(container, glbUrl) {
    const { GLTFLoader, DRACOLoader } = await getESMLoaders();
    const OrbitControlsCtor = await getESMControls();
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xffffff);
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    const width = container.clientWidth || container.offsetWidth || (container.parentElement ? container.parentElement.clientWidth : 300) || 300;
    const height = container.clientHeight || container.offsetHeight || 300;
    renderer.setSize(width, height);
    container.appendChild(renderer.domElement);
    const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 5000);
    camera.position.set(1.5, 1.5, 1.5);
    const controls = new OrbitControlsCtor(camera, renderer.domElement);
    controls.enableDamping = true;
    scene.add(new THREE.AmbientLight(0xffffff, 0.8));
    const dir = new THREE.DirectionalLight(0xffffff, 0.6);
    dir.position.set(5, 10, 7);
    scene.add(dir);
    const loader = new GLTFLoader();
    const draco = new DRACOLoader();
    draco.setDecoderPath('https://unpkg.com/three@' + (resolveThreeSemver() || '0.164.1') + '/examples/jsm/libs/draco/');
    loader.setDRACOLoader(draco);
    loader.setCrossOrigin('anonymous');
    loader.load(glbUrl, (gltf) => {
        const root = gltf.scene;
        scene.add(root);
        root.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
        const box = new THREE.Box3().setFromObject(root);
        const size = box.getSize(new THREE.Vector3());
        const center = box.getCenter(new THREE.Vector3());
        root.position.sub(center);
        const maxDim = Math.max(size.x, size.y, size.z);
        const distance = maxDim / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
        camera.position.set(distance, distance, distance);
        camera.lookAt(0, 0, 0);
        camera.updateProjectionMatrix();
    }, (xhr) => {
        const pct = xhr.total ? Math.round((xhr.loaded / xhr.total) * 100) : Math.round(xhr.loaded / 1000) + 'KB';
        console.log('GLB loading progress:', pct);
    }, (err) => {
        console.error('GLB load error (viewer):', err);
        const msg = document.createElement('div');
        msg.style.cssText = 'padding:8px;color:#b00;font-size:12px;';
        msg.textContent = 'Failed to load GLB. See console for details.';
        container.appendChild(msg);
    });
    function animate() { requestAnimationFrame(animate); controls.update(); renderer.render(scene, camera); }
    animate();
    new ResizeObserver(() => {
        const w = container.clientWidth || container.offsetWidth || 300; const h = container.clientHeight || container.offsetHeight || 300;
        renderer.setSize(w, h); camera.aspect = w / h; camera.updateProjectionMatrix();
    }).observe(container);
}

async function enableTripoPlacement(glbUrl, structureId = null) {
    // If already placed for this structure, do nothing
    if (structureId && placedModelsByStructure.has(structureId)) {
        console.log(`Structure ${structureId} already has a model placed`);
        return;
    }
    // Load GLB (cached if possible)
    const gltfRoot = await loadGLTFRoot(glbUrl);
    cachedTripoGLB = gltfRoot;
 
    // Basic import: convert metres->segments and drop pivot at origin
    gltfRoot.scale.multiplyScalar(1 / METERS_PER_SEGMENT);
    gltfRoot.updateMatrixWorld(true);
 
    // Choose initial position – center of target structure if provided, else (0,0,0)
    let startPos = new THREE.Vector3(0, 0, 0);
    if (structureId) {
        const b = computeStructureBoundsById(structureId);
        if (b) startPos.addVectors(b.min, b.max).multiplyScalar(0.5);
    }
    gltfRoot.position.copy(startPos);
 
    // Add anchor / pivot visual helper
    const anchorHelper = new THREE.AxesHelper(1.5 * voxelSize);
    anchorHelper.name = 'anchorHelper';
    gltfRoot.add(anchorHelper);
 
    scene.add(gltfRoot);
 
    // Attach interactive gizmos + numeric panel
    await attachTripoTransformControls(gltfRoot);
    showTransformPanel(gltfRoot);
 
    tripoModelGroup = gltfRoot;
    tripoPlacementEnabled = true;
    if (structureId) {
        placedModelsByStructure.set(structureId, { group: gltfRoot, glbUrl });
    }
    persistStateIfEnabled?.();
    return; // Skip legacy automatic placement logic
}

function chooseBestAxisAlignedRotation(modelSize, targetSize) {
    const rotations = generateAxisAlignedRotations();
    const longestAxisIndex = (modelSize.y >= modelSize.x && modelSize.y >= modelSize.z) ? 1 : (modelSize.x >= modelSize.z ? 0 : 2);
    let best = { err: Infinity, matrix: new THREE.Matrix4(), rotatedSize: modelSize.clone() };
    rotations.forEach(m => {
        // rotated size under axis-aligned rotation = permutation of size
        const axes = [
            new THREE.Vector3().setFromMatrixColumn(m, 0),
            new THREE.Vector3().setFromMatrixColumn(m, 1),
            new THREE.Vector3().setFromMatrixColumn(m, 2)
        ];
        const abs = axes.map(a => new THREE.Vector3(Math.abs(a.x), Math.abs(a.y), Math.abs(a.z)));
        const rotated = new THREE.Vector3(
            modelSize.x * abs[0].x + modelSize.y * abs[0].y + modelSize.z * abs[0].z,
            modelSize.x * abs[1].x + modelSize.y * abs[1].y + modelSize.z * abs[1].z,
            modelSize.x * abs[2].x + modelSize.y * abs[2].y + modelSize.z * abs[2].z
        );
        const s = Math.min(
            targetSize.x / Math.max(1e-6, rotated.x),
            targetSize.y / Math.max(1e-6, rotated.y),
            targetSize.z / Math.max(1e-6, rotated.z)
        );
        // residual error after uniform scaling
        const rx = s * rotated.x - targetSize.x;
        const ry = s * rotated.y - targetSize.y;
        const rz = s * rotated.z - targetSize.z;
        let err = rx * rx + ry * ry + rz * rz;
        // Upright bias: encourage mapping the model's longest axis to +Y
        const mapVec = axes[longestAxisIndex];
        const yAlign = Math.max(0, mapVec.y); // prefer +Y
        const bias = (1 - yAlign) * (targetSize.x + targetSize.y + targetSize.z);
        err += bias * 0.01;
        if (err < best.err) {
            best = { err, matrix: m, rotatedSize: rotated };
        }
    });
    return best;
}

function generateAxisAlignedRotations() {
    const mats = [];
    const bases = [
        new THREE.Vector3(1, 0, 0), new THREE.Vector3(-1, 0, 0),
        new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, -1, 0),
        new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, -1)
    ];
    // choose world X from bases, world Y from bases not colinear, world Z = X x Y (right-handed)
    for (const ex of bases) {
        for (const ey of bases) {
            if (Math.abs(ex.dot(ey)) > 0.001) continue; // must be orthogonal
            const ez = new THREE.Vector3().crossVectors(ex, ey);
            if (ez.lengthSq() < 0.9) continue; // reject degenerate
            const m = new THREE.Matrix4().makeBasis(ex.clone(), ey.clone(), ez.clone());
            // ensure determinant +1 (proper rotation)
            const det = m.determinant();
            if (det < 0.9) continue;
            mats.push(m);
        }
    }
    return mats;
}

function disableTripoPlacement(structureId = null) {
    // If structureId is provided, only remove that specific model
    if (structureId) {
        const modelData = placedModelsByStructure.get(structureId);
        if (modelData && modelData.group) {
            scene.remove(modelData.group);
            modelData.group.traverse(obj => {
                if (obj.isMesh) {
                    if (obj.geometry) obj.geometry.dispose();
                    if (obj.material) {
                        if (Array.isArray(obj.material)) obj.material.forEach(m => m.dispose());
                        else obj.material.dispose();
                    }
                }
            });
            placedModelsByStructure.delete(structureId);
            
            // If this was the active model, clear it and detach controls
            if (tripoModelGroup === modelData.group) {
                tripoModelGroup = null;
                detachTripoTransformControls();
                tripoPlacementEnabled = false;
            }
        }
    } else {
        // Remove all models (legacy behavior)
        if (!tripoPlacementEnabled) return;
        if (tripoModelGroup) {
            scene.remove(tripoModelGroup);
            tripoModelGroup.traverse(obj => {
                if (obj.isMesh) {
                    if (obj.geometry) obj.geometry.dispose();
                    if (obj.material) {
                        if (Array.isArray(obj.material)) obj.material.forEach(m => m.dispose());
                        else obj.material.dispose();
                    }
                }
            });
            tripoModelGroup = null;
        }
        detachTripoTransformControls();
        if (focusMode) restoreOriginalFocusedStructure();
        tripoPlacementEnabled = false;
    }
}

async function loadGLTFRoot(glbUrl) {
    const { GLTFLoader, DRACOLoader } = await getESMLoaders();
    const loader = new GLTFLoader();
    const draco = new DRACOLoader();
    draco.setDecoderPath('https://unpkg.com/three@' + (resolveThreeSemver() || '0.164.1') + '/examples/jsm/libs/draco/');
    loader.setDRACOLoader(draco);
    loader.setCrossOrigin('anonymous');
    return new Promise((resolve, reject) => {
        loader.load(glbUrl, (gltf) => resolve(gltf.scene), (xhr) => {
            const pct = xhr.total ? Math.round((xhr.loaded / xhr.total) * 100) : Math.round(xhr.loaded / 1000) + 'KB';
            console.log('GLB placement progress:', pct);
        }, (err) => {
            console.error('GLB load error (placement):', err);
            reject(err);
        });
    });
}

function computePlacementBounds() {
    if (focusMode && focusedStructureVoxels.size > 0) {
        return computeFocusedStructureBounds();
    }
    if (selectedVoxels.length > 0) {
        let min = new THREE.Vector3(Infinity, Infinity, Infinity);
        let max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
        selectedVoxels.forEach(v => {
            const p = v.position;
            min.min(new THREE.Vector3(Math.round(p.x), Math.round(p.y), Math.round(p.z)));
            max.max(new THREE.Vector3(Math.round(p.x), Math.round(p.y), Math.round(p.z)));
        });
        return { min, max };
    }
    if (voxels.length > 0) {
        let min = new THREE.Vector3(Infinity, Infinity, Infinity);
        let max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
        voxels.forEach(v => {
            const p = v.position;
            min.min(new THREE.Vector3(Math.round(p.x), Math.round(p.y), Math.round(p.z)));
            max.max(new THREE.Vector3(Math.round(p.x), Math.round(p.y), Math.round(p.z)));
        });
        return { min, max };
    }
    // Fallback to origin 1x1x1 box
    return { min: new THREE.Vector3(-0.5, 0, -0.5), max: new THREE.Vector3(0.5, 1, 0.5) };
}

function addLocalGlbCard(glbUrl, onCleanup) {
    // Skip if card for this GLB already exists
    const existing = document.querySelector(`.capture-item[data-glb="${glbUrl}"]`);
    if (existing) return existing;

    const gallery = document.getElementById('captureGallery');
    const item = document.createElement('div');
    item.className = 'capture-item';
    item.dataset.type = 'localglb';
    item.dataset.glb = glbUrl;
    item.innerHTML = `
        <div class="capture-header">
            <div class="capture-label">LOCAL GLB</div>
            <a class="download-btn" href="${glbUrl}" download="example.glb">Download</a>
        </div>
        <div class="tripo-viewer" style="height: 320px; background: #f6f6f6; border: 1px solid #e6e6e6; border-radius: 4px;"></div>
        <div class="capture-actions" style="margin-top: 8px; display: flex; align-items: center; gap: 12px;">
            <button class="place-remove-btn" data-action="place" style="padding: 6px 12px; background: #4CAF50; color: white; border: none; border-radius: 4px; cursor: pointer;">
                Place in Scene
            </button>
        </div>
    `;
    gallery && gallery.prepend(item);
    const container = item.querySelector('.tripo-viewer');
    initTripoViewer(container, glbUrl);
    saveCurrentGalleryState();
    const placeBtn = item.querySelector('.place-remove-btn');
    placeBtn.addEventListener('click', async (e) => {
        const btn = e.target;
        if (btn.dataset.action === 'place') {
            try {
                await enableTripoPlacement(glbUrl);
                btn.textContent = 'Remove';
                btn.dataset.action = 'remove';
                btn.style.background = '#f44336';
            } catch (err) {
                console.error('Placement failed:', err);
                alert('Placement failed. See console for details.');
            }
        } else {
            disableTripoPlacement();
            btn.textContent = 'Place in Scene';
            btn.dataset.action = 'place';
            btn.style.background = '#4CAF50';
        }
    });
    if (onCleanup) {
        item.addEventListener('remove', onCleanup, { once: true });
    }
    persistStateIfEnabled();
}

async function getESMLoaders() {
    const rev = resolveThreeSemver() || '0.164.1';
    const base = `https://esm.sh/three@${rev}`;
    const loaders = await Promise.all([
        import(`${base}/examples/jsm/loaders/GLTFLoader.js`),
        import(`${base}/examples/jsm/loaders/DRACOLoader.js`)
    ]);
    const GLTFLoader = loaders[0].GLTFLoader || loaders[0].default?.GLTFLoader || loaders[0];
    const DRACOLoader = loaders[1].DRACOLoader || loaders[1].default?.DRACOLoader || loaders[1];
    return { GLTFLoader, DRACOLoader };
}

const __loadedScripts = new Set();
function loadScriptOnce(key, src) {
    if (__loadedScripts.has(key)) return Promise.resolve();
    return new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = src; s.async = true; s.crossOrigin = 'anonymous';
        s.onload = () => { __loadedScripts.add(key); resolve(); };
        s.onerror = (e) => { console.error('Script load failed:', src, e); reject(e); };
        document.head.appendChild(s);
    });
}

async function getESMControls() {
    const rev = resolveThreeSemver() || '0.164.1';
    const base = `https://esm.sh/three@${rev}`;
    const mod = await import(`${base}/examples/jsm/controls/OrbitControls.js`);
    return mod.OrbitControls || mod.default?.OrbitControls || mod;
}

async function getESMTransformControls() {
    const rev = resolveThreeSemver() || '0.164.1';
    const base = `https://esm.sh/three@${rev}`;
    const mod = await import(`${base}/examples/jsm/controls/TransformControls.js`);
    return mod.TransformControls || mod.default?.TransformControls || mod;
}

async function attachTripoTransformControls(target) {
    const TransformControlsCtor = await getESMTransformControls();
    if (tripoTransformControls) {
        tripoTransformControls.detach();
        scene.remove(tripoTransformControls);
        tripoTransformControls = null;
    }
    tripoTransformControls = new TransformControlsCtor(camera, renderer.domElement);
    tripoTransformControls.setMode('translate');
    tripoTransformControls.setSpace('world');
    let lastRotation = { x: 0, y: 0, z: 0 };
    let lastScale = 1;
    
    // Store initial values
    if (target) {
        lastRotation = {
            x: target.rotation.x * 180 / Math.PI,
            y: target.rotation.y * 180 / Math.PI,
            z: target.rotation.z * 180 / Math.PI
        };
        lastScale = target.scale.x;
    }
    
    // Enforce uniform scale when in scale mode
    let initialScale = target ? target.scale.x : 1;
    let isDraggingScale = false;
    
    tripoTransformControls.addEventListener('dragging-changed', (e) => {
        isDraggingGizmo = e.value;
        const mode = typeof tripoTransformControls.getMode === 'function' ? tripoTransformControls.getMode() : tripoTransformControls.mode;
        updateCornerScores();
        
        if (mode === 'scale') {
            if (e.value) {
                // Starting to drag - store initial scale
                initialScale = target ? target.scale.x : 1;
                isDraggingScale = true;
            } else {
                // Finished dragging
                isDraggingScale = false;
            }
        }
        
        // Log changes when dragging ends
        if (!e.value && target) {
            if (mode === 'rotate') {
                const currentRotation = {
                    x: target.rotation.x * 180 / Math.PI,
                    y: target.rotation.y * 180 / Math.PI,
                    z: target.rotation.z * 180 / Math.PI
                };
                const deltaX = currentRotation.x - lastRotation.x;
                const deltaY = currentRotation.y - lastRotation.y;
                const deltaZ = currentRotation.z - lastRotation.z;
                
                if (Math.abs(deltaX) > 0.1) console.log(`Rotated X by ${deltaX.toFixed(1)}°`);
                if (Math.abs(deltaY) > 0.1) console.log(`Rotated Y by ${deltaY.toFixed(1)}°`);
                if (Math.abs(deltaZ) > 0.1) console.log(`Rotated Z by ${deltaZ.toFixed(1)}°`);
                
                lastRotation = currentRotation;
            }
            
            if (mode === 'scale') {
                const currentScale = target.scale.x;
                const deltaScale = currentScale / lastScale;
                if (Math.abs(deltaScale - 1) > 0.01) {
                    console.log(`Scaled by ${deltaScale.toFixed(2)}x (now ${currentScale.toFixed(2)}x total)`);
                }
                lastScale = currentScale;
            }
        }
    });
    
    tripoTransformControls.addEventListener('objectChange', () => {
        const mode = typeof tripoTransformControls.getMode === 'function' ? tripoTransformControls.getMode() : tripoTransformControls.mode;
        if (mode === 'scale' && target && isDraggingScale) {
            const s = target.scale;
            // Find which axis changed the most from the initial scale
            const deltaX = Math.abs(s.x - initialScale);
            const deltaY = Math.abs(s.y - initialScale);
            const deltaZ = Math.abs(s.z - initialScale);
            
            let factor;
            if (deltaX >= deltaY && deltaX >= deltaZ) {
                factor = s.x;
            } else if (deltaY >= deltaZ) {
                factor = s.y;
            } else {
                factor = s.z;
            }
            
            target.scale.setScalar(factor);
        }
        updateCornerScores();
        updateTransformPanel();
    });
    tripoTransformControls.attach(target);
    scene.add(tripoTransformControls);
    // show HUD
    const hud = document.getElementById('transformHud');
    if (hud) {
        hud.style.display = 'block';
        // Add collapse functionality if not already added
        const toggleBtn = hud.querySelector('.transform-hud-toggle');
        if (toggleBtn && !toggleBtn.hasAttribute('data-listener-added')) {
            toggleBtn.setAttribute('data-listener-added', 'true');
            toggleBtn.addEventListener('click', () => {
                hud.classList.toggle('collapsed');
            });
        }
    }

    // Show numeric panel for this target
    showTransformPanel(target);
}

function detachTripoTransformControls() {
    // Detach and dispose controls if present
    if (tripoTransformControls) {
        tripoTransformControls.detach();
        scene.remove(tripoTransformControls);
        tripoTransformControls.dispose?.();
        tripoTransformControls = null;
    }

    // Hide any HUD
    const hud = document.getElementById('transformHud');
    if (hud) hud.style.display = 'none';

    // Always remove numeric transform panel (even if controls were already gone)
    if (transformPanel) {
        transformPanel.remove();
        transformPanel = null;
        transformPanelObject = null;
    }
    
    // Remove corner highlights
    ['swCornerHighlight', 'cornerTestRegions'].forEach(name => {
        const highlight = scene.getObjectByName(name);
        if (highlight) {
            scene.remove(highlight);
        }
    });
}


function resolveThreeSemver() {
    const rev = (THREE && THREE.REVISION) ? String(THREE.REVISION).trim() : '';
    if (/^\d+$/.test(rev)) return `0.${rev}.0`;
    return rev || '0.164.1';
}

function isTypingIntoInput(event) {
    const el = event.target;
    if (!el) return false;
    if (el.isContentEditable) return true;
    const tag = (el.tagName || '').toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select';
}

function setGroundElevation(raised) {
    // Ground is always at the foot of the structure (top of ground grid): y = 0
    const y = 0;
    scene.children.forEach(child => {
        if (child.userData && (child.userData.isGridHelper || child.userData.isGridPlane)) {
            child.position.y = y;
            if (typeof child.updateMatrixWorld === 'function') child.updateMatrixWorld(true);
        }
    });
    if (originMarker) originMarker.position.y = y;
}

async function addSkinToFocusedStructure(imageUrl) {
    if (!focusedStructure) {
        showToast('Load a saved structure first', 'error');
        debugLog('skin:error:no-structure');
        return;
    }
    debugLog('skin:start', { imageUrl: imageUrl.slice(0, 64) });
    const publicUrl = imageUrl.startsWith('data:') ? (await uploadViaFalClient(imageUrl)) || imageUrl : imageUrl;
    if (publicUrl === imageUrl && imageUrl.startsWith('data:')) {
        showToast('Could not upload image for background removal', 'error');
        debugLog('skin:upload:miss');
    } else {
        debugLog('skin:upload:ok', { publicUrl: publicUrl.slice(0, 64) });
    }
    const processedUrl = await removeBackground(publicUrl) || publicUrl;
    debugLog('skin:bg-removed', { processedUrl: processedUrl.slice(0, 64), usedRMBG: processedUrl !== publicUrl });
    // Save to structure
    const id = focusedStructure.id;
    if (!structureIdToSkinUrls.has(id)) structureIdToSkinUrls.set(id, []);
    const arr = structureIdToSkinUrls.get(id);
    arr.push(processedUrl);
    activeSkinIndex.set(id, arr.length - 1);
    applyActiveSkinForFocusedStructure();
    updateStructuresMenu();
    showToast('Skin applied', 'success');
}

function applyActiveSkinForFocusedStructure() {
    if (!focusedStructure) return;
    const id = focusedStructure.id;
    const arr = structureIdToSkinUrls.get(id) || [];
    const idx = activeSkinIndex.get(id) ?? -1; // -1 means none
    if (idx < 0) {
        clearSkinOverlay();
        debugLog('skin:apply:none');
        return;
    }
    const url = arr[idx];
    if (!url) { clearSkinOverlay(); return; }
    addScreenSpaceSkin(url);
}

function clearSkinOverlay() {
    const layer = document.getElementById('skinOverlayLayer');
    if (!layer) return;
    layer.innerHTML = '';
    skinEls.forEach(el => el.remove());
    skinEls.clear();
    skinStates.clear();
}

function cycleSkin(structureId, dir) {
    const arr = structureIdToSkinUrls.get(structureId) || [];
    const options = arr.length + 1; // include 'none' at ordinal 0
    if (options <= 1) { clearSkinOverlay(); activeSkinIndex.set(structureId, -1); return; }
    const current = activeSkinIndex.get(structureId) ?? -1; // -1 -> none
    let ordinal = current + 1; // map -1..n-1 to 0..n
    ordinal = (ordinal + dir + options) % options;
    const nextIndex = ordinal - 1; // back to -1..n-1
    activeSkinIndex.set(structureId, nextIndex);
    if (focusedStructure && focusedStructure.id === structureId) {
        applyActiveSkinForFocusedStructure();
    }
}

function computeBoundsForResetCamera() {
    if (focusMode && focusedStructureVoxels.size > 0) {
        return computeFocusedStructureBounds();
    }
    if (focusedStructure) {
        return computeFocusedStructureBounds();
    }
    if (voxels.length > 0) {
        let min = new THREE.Vector3(Infinity, Infinity, Infinity);
        let max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
        voxels.forEach(v => {
            const p = v.position;
            min.min(new THREE.Vector3(Math.round(p.x), Math.round(p.y), Math.round(p.z)));
            max.max(new THREE.Vector3(Math.round(p.x), Math.round(p.y), Math.round(p.z)));
        });
        return { min, max };
    }
    // fallback to grid extents
    const min = new THREE.Vector3(-Math.floor(gridSizeX/2), 0, -Math.floor(gridSizeZ/2));
    const max = new THREE.Vector3(Math.ceil(gridSizeX/2), Math.max(1, heightLimit), Math.ceil(gridSizeZ/2));
    return { min, max };
}

async function removeBackground(imageUrl) {
    try {
        await ensureEnvLoaded();
        const apiKey = window.FAL_KEY || localStorage.getItem('FAL_KEY');
        if (!apiKey) return null;
        const res = await fetch('https://fal.run/fal-ai/bria/background/remove', {
            method: 'POST',
            headers: { 'Authorization': `Key ${apiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ image_url: imageUrl, sync_mode: true })
        });
        if (!res.ok) return null;
        const data = await res.json();
        return data?.image?.url || null;
    } catch (e) {
        console.warn('Background removal failed:', e);
        return null;
    }
}

function addScreenSpaceSkin(imageUrl) {
    const layer = document.getElementById('skinOverlayLayer');
    if (!layer) { debugLog('skin:layer:missing'); return; }
    // Wrapper allows visible adjust frame and simpler transforms
    const wrap = document.createElement('div');
    wrap.style.position = 'absolute';
    wrap.style.pointerEvents = 'none';
    wrap.style.boxSizing = 'border-box';
    wrap.style.border = skinAdjustActive ? '1px dashed #00e5ff' : 'none';
    const img = document.createElement('img');
    img.src = imageUrl;
    img.onload = () => debugLog('skin:image:onload', { naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight });
    img.onerror = (e) => debugLog('skin:image:onerror');
    img.style.width = '100%';
    img.style.height = '100%';
    const rect = computeFocusedStructureScreenRect();
    if (rect) {
        wrap.style.left = `${rect.x}px`;
        wrap.style.top = `${rect.y}px`;
        wrap.style.width = `${rect.w}px`;
        wrap.style.height = `${rect.h}px`;
        wrap.style.transform = `translate(0,0) scale(${skinAdjustState.scale}) translate(${skinAdjustState.x}px, ${skinAdjustState.y}px)`;
    } else {
        wrap.style.left = '50%';
        wrap.style.top = '50%';
        wrap.style.transform = `translate(-50%, -50%) scale(${skinAdjustState.scale}) translate(${skinAdjustState.x}px, ${skinAdjustState.y}px)`;
        debugLog('skin:rect:missing');
    }
    wrap.style.filter = 'drop-shadow(0 2px 6px rgba(0,0,0,0.25))';
    wrap.appendChild(img);
    layer.appendChild(wrap);
    // Store; caller will update position via updateScreenOverlayTransform
    if (focusedStructure) {
        skinEls.set(focusedStructure.id, wrap);
        if (!skinStates.has(focusedStructure.id)) skinStates.set(focusedStructure.id, { x: 0, y: 0, scale: 1 });
    }
    updateScreenOverlayVisibility();
    updateScreenOverlayTransform();
    updateSkinDebug();
}

function updateScreenOverlayVisibility() {
    const layer = document.getElementById('skinOverlayLayer');
    if (!layer) return;
    const elev = THREE.MathUtils.degToRad(DEFAULT_ISO_ELEVATION_DEG);
    const az = THREE.MathUtils.degToRad(DEFAULT_ISO_AZIMUTH_DEG);
    // THREE cameras look down -Z; getWorldDirection returns forward (-Z in world). Our analytic dir must match that forward.
    const defaultDir = new THREE.Vector3(Math.cos(elev) * Math.cos(az), Math.sin(elev), Math.cos(elev) * Math.sin(az)).normalize().negate();
    const curDir = new THREE.Vector3();
    camera.getWorldDirection(curDir);
    const dot = curDir.normalize().dot(defaultDir);
    layer.style.display = (dot > 0.995) ? 'block' : 'none';
    // Removed skin visibility debug logging
}

function updateScreenOverlayTransform() {
    if (skinEls.size === 0) return;
    skinEls.forEach((el, structureId) => {
        const rect = computeStructureScreenRect(structureId);
        const state = skinStates.get(structureId) || { x: 0, y: 0, scale: 1 };
        if (rect) {
            el.style.left = `${rect.x}px`;
            el.style.top = `${rect.y}px`;
            el.style.width = `${rect.w}px`;
            el.style.height = `${rect.h}px`;
            el.style.transform = `translate(0,0) scale(${state.scale}) translate(${state.x}px, ${state.y}px)`;
        }
    });
    updateSkinDebug();
}

function computeFocusedStructureScreenRect() {
    if (!focusedStructure) return null;
    return computeStructureScreenRect(focusedStructure.id);
}

function computeStructureScreenRect(structureId) {
    const bounds = computeStructureBoundsById(structureId);
    const corners = [];
    for (let xi of [bounds.min.x, bounds.max.x]) {
        for (let yi of [bounds.min.y, bounds.max.y]) {
            for (let zi of [bounds.min.z, bounds.max.z]) {
                corners.push(new THREE.Vector3(xi, yi, zi));
            }
        }
    }
    const container = document.getElementById('scene-container');
    if (!container) return null;
    const width = container.clientWidth;
    const height = container.clientHeight;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    const proj = corners.map(p => p.clone().project(camera));
    proj.forEach(v => {
        const sx = (v.x * 0.5 + 0.5) * width;
        const sy = (-v.y * 0.5 + 0.5) * height;
        minX = Math.min(minX, sx); maxX = Math.max(maxX, sx);
        minY = Math.min(minY, sy); maxY = Math.max(maxY, sy);
    });
    if (!isFinite(minX) || !isFinite(minY) || !isFinite(maxX) || !isFinite(maxX)) return null;
    const margin = 8;
    const rect = { x: Math.max(0, minX - margin), y: Math.max(0, minY - margin), w: Math.max(1, (maxX - minX) + margin * 2), h: Math.max(1, (maxY - minY) + margin * 2) };
    debugLog('skin:rect', rect);
    return rect;
}

function computeStructureBoundsById(structureId) {
    const s = savedStructures.find(ss => ss.id === structureId);
    if (!s || !s.data || s.data.length === 0) return computeFocusedStructureBounds();
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    s.data.forEach(v => {
        const p = Array.isArray(v.position) ? v.position : v.position?.toArray?.() || v.position;
        if (!p) return;
        const x = Math.round(p[0]);
        const y = Math.round(p[1]);
        const z = Math.round(p[2]);
        minX = Math.min(minX, x); minY = Math.min(minY, y); minZ = Math.min(minZ, z);
        maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); maxZ = Math.max(maxZ, z);
    });
    return { min: new THREE.Vector3(minX, minY, minZ), max: new THREE.Vector3(maxX, maxY, maxZ) };
}

function updateSkinDebug() {
    const dbg = document.getElementById('skinDebug');
    if (!dbg) return;
    const layer = document.getElementById('skinOverlayLayer');
    const rect = focusedStructure ? computeStructureScreenRect(focusedStructure.id) : null;
    const elev = THREE.MathUtils.degToRad(DEFAULT_ISO_ELEVATION_DEG);
    const az = THREE.MathUtils.degToRad(DEFAULT_ISO_AZIMUTH_DEG);
    const defaultDir = new THREE.Vector3(Math.cos(elev) * Math.cos(az), Math.sin(elev), Math.cos(elev) * Math.sin(az)).normalize().negate();
    const curDir = new THREE.Vector3();
    camera.getWorldDirection(curDir);
    const dot = curDir.normalize().dot(defaultDir);
    dbg.style.display = 'block';
    dbg.textContent = `overlay:${layer ? layer.style.display : 'n/a'} dot:${dot.toFixed(3)} rect:${rect ? `${rect.w}x${rect.h}` : 'none'} zoom:${currentZoom.toFixed(2)} skins:${skinEls.size}`;
}

function debugLog(tag, payload) {
    console.log(`[debug] ${tag}`, payload || '');
}

function toggleSkinAdjust(structureId, buttonEl) {
    // Only allow adjusting one structure at a time
    if (skinAdjustActive && adjustingStructureId !== structureId) {
        // Turn off previous
        toggleSkinAdjust(adjustingStructureId, null);
    }
    skinAdjustActive = !skinAdjustActive;
    adjustingStructureId = skinAdjustActive ? structureId : null;
    if (buttonEl) buttonEl.textContent = skinAdjustActive ? '✔' : '🎯';
    const el = skinEls.get(structureId);
    if (el) {
        el.style.pointerEvents = skinAdjustActive ? 'auto' : 'none';
        el.style.border = skinAdjustActive ? '1px dashed #00e5ff' : 'none';
    }
    const layer = document.getElementById('skinOverlayLayer');
    if (!layer || !el) return;
    if (skinAdjustActive) {
        showToast('Adjust skin: drag to move, use corner handles to scale, click ✔ when done.', 'info');
        lastPointer = null;
        layer.addEventListener('pointerdown', onSkinPointerDown);
        window.addEventListener('pointermove', onSkinPointerMove, { passive: true });
        window.addEventListener('pointerup', onSkinPointerUp);
        layer.addEventListener('wheel', onSkinWheel, { passive: false });
        renderSkinGizmoHandles();
    } else {
        showToast('Adjustment applied', 'success');
        layer.removeEventListener('pointerdown', onSkinPointerDown);
        window.removeEventListener('pointermove', onSkinPointerMove);
        window.removeEventListener('pointerup', onSkinPointerUp);
        layer.removeEventListener('wheel', onSkinWheel);
        clearSkinGizmoHandles();
    }
}

function onSkinPointerDown(e) {
    if (!skinAdjustActive) return;
    lastPointer = { x: e.clientX, y: e.clientY };
    try { e.target.setPointerCapture?.(e.pointerId); } catch {}
}

function onSkinPointerMove(e) {
    if (!skinAdjustActive || !lastPointer) return;
    const dx = e.clientX - lastPointer.x;
    const dy = e.clientY - lastPointer.y;
    const sid = adjustingStructureId;
    if (!sid) return;
    const st = skinStates.get(sid) || { x: 0, y: 0, scale: 1 };
    st.x += dx; st.y += dy; skinStates.set(sid, st);
    lastPointer = { x: e.clientX, y: e.clientY };
    updateScreenOverlayTransform();
}

function onSkinPointerUp(e) {
    lastPointer = null;
}

function onSkinWheel(e) {
    if (!skinAdjustActive) return;
    e.preventDefault();
    const delta = e.deltaY;
    const factor = Math.exp(-delta * 0.001);
    const sid = adjustingStructureId; if (!sid) return;
    const st = skinStates.get(sid) || { x: 0, y: 0, scale: 1 };
    const before = st.scale;
    st.scale = Math.max(0.1, Math.min(5, before * factor));
    skinStates.set(sid, st);
    debugLog('skin:scale', { from: before.toFixed(3), to: st.scale.toFixed(3), delta: (st.scale - before).toFixed(3) });
    updateScreenOverlayTransform();
}

function showToast(message, type = 'info', timeout = 3000) {
    const cont = document.getElementById('toastContainer');
    if (!cont) return;
    const div = document.createElement('div');
    div.className = `toast ${type}`;
    div.textContent = message;
    cont.appendChild(div);
    setTimeout(() => {
        div.remove();
    }, timeout);
}

function renderSkinGizmoHandles() {
    if (!skinEls.size === 0) return;
    clearSkinGizmoHandles();
    const add = (left, top, cursor) => {
        const h = document.createElement('div');
        h.className = 'skin-gizmo-handle';
        h.style.left = left;
        h.style.top = top;
        if (cursor) h.style.cursor = cursor;
        h.addEventListener('pointerdown', onSkinHandleDown);
        skinEls.get(structureId).appendChild(h);
        return h;
    };
    // four corners
    add('-6px', '-6px', 'nwse-resize');
    add('calc(100% - 6px)', '-6px', 'nesw-resize');
    add('-6px', 'calc(100% - 6px)', 'nesw-resize');
    add('calc(100% - 6px)', 'calc(100% - 6px)', 'nwse-resize');
    const centerDot = document.createElement('div');
    centerDot.className = 'skin-gizmo-center';
    centerDot.style.left = 'calc(50% - 4px)';
    centerDot.style.top = 'calc(50% - 4px)';
    skinEls.get(structureId).appendChild(centerDot);
}

function clearSkinGizmoHandles() {
    if (!skinEls.size === 0) return;
    [...skinEls.values()].forEach(el => {
        [...el.querySelectorAll('.skin-gizmo-handle,.skin-gizmo-center')].forEach(n => n.remove());
    });
}

let activeHandle = null;
let handleStart = null;
function onSkinHandleDown(e) {
    if (!skinAdjustActive) return;
    e.stopPropagation();
    activeHandle = e.currentTarget;
    handleStart = { x: e.clientX, y: e.clientY, scale: skinAdjustState.scale };
    try { activeHandle.setPointerCapture?.(e.pointerId); } catch {}
    window.addEventListener('pointermove', onSkinHandleMove, { passive: true });
    window.addEventListener('pointerup', onSkinHandleUp);
}

function onSkinHandleMove(e) {
    if (!activeHandle || !handleStart) return;
    const dx = e.clientX - handleStart.x;
    const dy = e.clientY - handleStart.y;
    const delta = Math.max(Math.abs(dx), Math.abs(dy));
    const factor = 1 + delta / 300 * (dx + dy >= 0 ? 1 : -1);
    const sid = adjustingStructureId; if (!sid) return;
    const st = skinStates.get(sid) || { x: 0, y: 0, scale: 1 };
    const before = st.scale;
    st.scale = Math.max(0.1, Math.min(5, handleStart.scale * factor));
    skinStates.set(sid, st);
    debugLog('skin:scale', { from: before.toFixed(3), to: st.scale.toFixed(3), delta: (st.scale - before).toFixed(3) });
    updateScreenOverlayTransform();
}

function onSkinHandleUp(e) {
    window.removeEventListener('pointermove', onSkinHandleMove);
    window.removeEventListener('pointerup', onSkinHandleUp);
    activeHandle = null;
    handleStart = null;
}

function computePCAAxesAndExtents(root) {
    // Collect world-space vertices
    const points = [];
    root.updateMatrixWorld(true);
    root.traverse(o => {
        if (o.isMesh && o.geometry && o.geometry.attributes && o.geometry.attributes.position) {
            const pos = o.geometry.attributes.position;
            const m = o.matrixWorld;
            const v = new THREE.Vector3();
            for (let i = 0; i < pos.count; i++) {
                v.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(m);
                points.push(v.clone());
            }
        }
    });
    if (points.length < 4) return null;
    // Mean
    const mean = new THREE.Vector3();
    for (const p of points) mean.add(p);
    mean.multiplyScalar(1 / points.length);
    // Covariance (symmetric)
    let c00 = 0, c01 = 0, c02 = 0, c11 = 0, c12 = 0, c22 = 0;
    for (const p of points) {
        const x = p.x - mean.x, y = p.y - mean.y, z = p.z - mean.z;
        c00 += x * x; c01 += x * y; c02 += x * z;
        c11 += y * y; c12 += y * z; c22 += z * z;
    }
    const invN = 1 / Math.max(1, points.length - 1);
    c00 *= invN; c01 *= invN; c02 *= invN; c11 *= invN; c12 *= invN; c22 *= invN;
    const cov = [c00, c01, c02, c01, c11, c12, c02, c12, c22];
    const eig = jacobiEigenSymmetric3(cov);
    if (!eig) return null;
    // Eigenvectors as columns, largest first
    const axes = [eig.vec0.clone().normalize(), eig.vec1.clone().normalize(), eig.vec2.clone().normalize()];
    // Ensure right-handed basis
    const ez = new THREE.Vector3().crossVectors(axes[0], axes[1]).normalize();
    if (ez.dot(axes[2]) < 0) axes[2].negate();
    // Extents along PCA axes
    let min0 = Infinity, min1 = Infinity, min2 = Infinity;
    let max0 = -Infinity, max1 = -Infinity, max2 = -Infinity;
    for (const p of points) {
        const d = new THREE.Vector3().subVectors(p, mean);
        const a0 = d.dot(axes[0]);
        const a1 = d.dot(axes[1]);
        const a2 = d.dot(axes[2]);
        if (a0 < min0) min0 = a0; if (a0 > max0) max0 = a0;
        if (a1 < min1) min1 = a1; if (a1 > max1) max1 = a1;
        if (a2 < min2) min2 = a2; if (a2 > max2) max2 = a2;
    }
    const sizes = new THREE.Vector3(max0 - min0, max1 - min1, max2 - min2);
    return { axes, sizes };
}

function jacobiEigenSymmetric3(m) {
    // m is length-9 array [m00,m01,m02,m10,m11,m12,m20,m21,m22] with m10=m01, etc.
    // Initialize V as identity
    let v00 = 1, v01 = 0, v02 = 0,
        v10 = 0, v11 = 1, v12 = 0,
        v20 = 0, v21 = 0, v22 = 1;
    let a00 = m[0], a01 = m[1], a02 = m[2], a11 = m[4], a12 = m[5], a22 = m[8];
    const maxIter = 32;
    for (let iter = 0; iter < maxIter; iter++) {
        // Find largest off-diagonal
        let p = 0, q = 1; let apq = Math.abs(a01);
        if (Math.abs(a02) > apq) { p = 0; q = 2; apq = Math.abs(a02); }
        if (Math.abs(a12) > apq) { p = 1; q = 2; apq = Math.abs(a12); }
        if (apq < 1e-10) break;
        // Compute rotation
        let app, aqq, apqVal;
        if (p === 0 && q === 1) { app = a00; aqq = a11; apqVal = a01; }
        else if (p === 0 && q === 2) { app = a00; aqq = a22; apqVal = a02; }
        else { app = a11; aqq = a22; apqVal = a12; }
        const phi = 0.5 * Math.atan2(2 * apqVal, (aqq - app));
        const c = Math.cos(phi), s = Math.sin(phi);
        // Apply rotation to A (symmetric update)
        if (p === 0 && q === 1) {
            const a00n = c * c * a00 - 2 * s * c * a01 + s * s * a11;
            const a11n = s * s * a00 + 2 * s * c * a01 + c * c * a11;
            const a01n = 0;
            const a02n = c * a02 - s * a12;
            const a12n = s * a02 + c * a12;
            a00 = a00n; a11 = a11n; a01 = a01n; a02 = a02n; a12 = a12n;
            // Update V columns 0 and 1
            const t00 = c * v00 - s * v10, t01 = c * v01 - s * v11, t02 = c * v02 - s * v12;
            const t10 = s * v00 + c * v10, t11 = s * v01 + c * v11, t12 = s * v02 + c * v12;
            v00 = t00; v01 = t01; v02 = t02; v10 = t10; v11 = t11; v12 = t12;
        } else if (p === 0 && q === 2) {
            const a00n = c * c * a00 - 2 * s * c * a02 + s * s * a22;
            const a22n = s * s * a00 + 2 * s * c * a02 + c * c * a22;
            const a02n = 0;
            const a01n = c * a01 - s * a12;
            const a12n = s * a01 + c * a12;
            a00 = a00n; a22 = a22n; a02 = a02n; a01 = a01n; a12 = a12n;
            const t00 = c * v00 - s * v20, t01 = c * v01 - s * v21, t02 = c * v02 - s * v22;
            const t20 = s * v00 + c * v20, t21 = s * v01 + c * v21, t22 = s * v02 + c * v22;
            v00 = t00; v01 = t01; v02 = t02; v20 = t20; v21 = t21; v22 = t22;
        } else {
            const a11n = c * c * a11 - 2 * s * c * a12 + s * s * a22;
            const a22n = s * s * a11 + 2 * s * c * a12 + c * c * a22;
            const a12n = 0;
            const a01n = c * a01 - s * a02;
            const a02n = s * a01 + c * a02;
            a11 = a11n; a22 = a22n; a12 = a12n; a01 = a01n; a02 = a02n;
            const t10 = c * v10 - s * v20, t11 = c * v11 - s * v21, t12 = c * v12 - s * v22;
            const t20 = s * v10 + c * v20, t21 = s * v11 + c * v21, t22 = s * v12 + c * v22;
            v10 = t10; v11 = t11; v12 = t12; v20 = t20; v21 = t21; v22 = t22;
        }
    }
    // Eigenvalues roughly on diagonal a00, a11, a22 of transformed A
    const evals = [a00, a11, a22];
    const evecs = [new THREE.Vector3(v00, v01, v02), new THREE.Vector3(v10, v11, v12), new THREE.Vector3(v20, v21, v22)];
    // Sort by eigenvalue descending
    const idx = [0,1,2].sort((i,j) => evals[j] - evals[i]);
    return {
        val0: evals[idx[0]], val1: evals[idx[1]], val2: evals[idx[2]],
        vec0: evecs[idx[0]], vec1: evecs[idx[1]], vec2: evecs[idx[2]]
    };
}

function chooseBestMappingUsingPCA(axes, sizes, targetSize) {
    // Try all permutations and signs mapping PCA axes to world X,Y,Z; keep right-handed
    const perms = [
        [0,1,2],[0,2,1],[1,0,2],[1,2,0],[2,0,1],[2,1,0]
    ];
    let best = null;
    const wX = 4, wZ = 4, wY = 1; // prioritize footprint alignment
    for (const p of perms) {
        for (const sx of [-1,1]) {
            for (const sy of [-1,1]) {
                const ex = axes[p[0]].clone().multiplyScalar(sx).normalize();
                const ey = axes[p[1]].clone().multiplyScalar(sy).normalize();
                let ez = new THREE.Vector3().crossVectors(ex, ey).normalize();
                if (ez.lengthSq() < 0.9) continue; // skip degenerate
                const m = new THREE.Matrix4().makeBasis(ex, ey, ez);
                const mappedSizes = new THREE.Vector3(sizes.getComponent(p[0]), sizes.getComponent(p[1]), sizes.getComponent(p[2]));
                // Weighted-LS optimal uniform scale
                const mx = mappedSizes.x, my = mappedSizes.y, mz = mappedSizes.z;
                const tx = targetSize.x, ty = targetSize.y, tz = targetSize.z;
                const denom = wX*mx*mx + wY*my*my + wZ*mz*mz;
                const s = denom > 1e-9 ? (wX*tx*mx + wY*ty*my + wZ*tz*mz) / denom : 1;
                const rx = s*mx - tx;
                const ry = s*my - ty;
                const rz = s*mz - tz;
                let cost = wX*rx*rx + wY*ry*ry + wZ*rz*rz;
                // Keep gravity sense reasonable but do not force it
                const upPenalty = Math.max(0, 1 - Math.max(0, ey.y));
                cost += upPenalty * 0.02 * (tx + ty + tz);
                // Footprint tie-breaker: prefer same major-axis orientation in XZ as target
                const tgtDiff = tx - tz;
                const mapDiff = mx - mz;
                cost += Math.abs(Math.sign(tgtDiff) - Math.sign(mapDiff)) * 0.01 * (tx + tz);
                if (!best || cost < best.cost) {
                    best = { cost, matrix: m, mappedSizes, scale: s };
                }
            }
        }
    }
    return best;
}

function chooseBestAxisAlignedRotation(modelSize, targetSize) {
    const rotations = generateAxisAlignedRotations();
    const longestAxisIndex = (modelSize.y >= modelSize.x && modelSize.y >= modelSize.z) ? 1 : (modelSize.x >= modelSize.z ? 0 : 2);
    let best = { err: Infinity, matrix: new THREE.Matrix4(), rotatedSize: modelSize.clone() };
    rotations.forEach(m => {
        // rotated size under axis-aligned rotation = permutation of size
        const axes = [
            new THREE.Vector3().setFromMatrixColumn(m, 0),
            new THREE.Vector3().setFromMatrixColumn(m, 1),
            new THREE.Vector3().setFromMatrixColumn(m, 2)
        ];
        const abs = axes.map(a => new THREE.Vector3(Math.abs(a.x), Math.abs(a.y), Math.abs(a.z)));
        const rotated = new THREE.Vector3(
            modelSize.x * abs[0].x + modelSize.y * abs[0].y + modelSize.z * abs[0].z,
            modelSize.x * abs[1].x + modelSize.y * abs[1].y + modelSize.z * abs[1].z,
            modelSize.x * abs[2].x + modelSize.y * abs[2].y + modelSize.z * abs[2].z
        );
        const mx = rotated.x, my = rotated.y, mz = rotated.z;
        const tx = targetSize.x, ty = targetSize.y, tz = targetSize.z;
        const denom = wX*mx*mx + wY*my*my + wZ*mz*mz;
        const s = denom > 1e-9 ? (wX*tx*mx + wY*ty*my + wZ*tz*mz) / denom : 1;
        const rx = s*mx - tx;
        const ry = s*my - ty;
        const rz = s*mz - tz;
        let err = wX*rx*rx + wY*ry*ry + wZ*rz*rz;
        // footprint tie-breaker
        const tgtDiff = tx - tz; const mapDiff = mx - mz;
        err += Math.abs(Math.sign(tgtDiff) - Math.sign(mapDiff)) * 0.01 * (tx + tz);
        if (err < best.err) {
            best = { err, matrix: m, rotatedSize: rotated, scale: s };
        }
    });
    return best;
}

function computeStructurePCA(structureId) {
    // Gather points from the specified structure; fall back to focusedStructureVoxels
    const pts = [];
    const push = (x,y,z) => pts.push(new THREE.Vector3(x,y,z));
    const s = savedStructures.find(ss => ss.id === structureId) || focusedStructure;
    if (s && s.data && s.data.length) {
        s.data.forEach(v => {
            const p = Array.isArray(v.position) ? v.position : v.position?.toArray?.() || v.position;
            if (!p) return; push(Math.round(p[0]), Math.round(p[1]), Math.round(p[2]));
        });
    } else if (focusedStructureVoxels.size > 0) {
        focusedStructureVoxels.forEach(v => { const p = v.position; push(Math.round(p.x), Math.round(p.y), Math.round(p.z)); });
    }
    if (pts.length < 4) return null;
    // Mean
    const mean = new THREE.Vector3(); pts.forEach(p => mean.add(p)); mean.multiplyScalar(1/pts.length);
    // Covariance
    let c00=0,c01=0,c02=0,c11=0,c12=0,c22=0; for (const p of pts){const x=p.x-mean.x,y=p.y-mean.y,z=p.z-mean.z;c00+=x*x;c01+=x*y;c02+=x*z;c11+=y*y;c12+=y*z;c22+=z*z;} const invN=1/Math.max(1,pts.length-1); c00*=invN;c01*=invN;c02*=invN;c11*=invN;c12*=invN;c22*=invN;
    const eig = jacobiEigenSymmetric3([c00,c01,c02,c01,c11,c12,c02,c12,c22]); if (!eig) return null;
    const axes = [eig.vec0.clone().normalize(), eig.vec1.clone().normalize(), eig.vec2.clone().normalize()];
    // Right-handed
    const ez = new THREE.Vector3().crossVectors(axes[0], axes[1]).normalize(); if (ez.dot(axes[2]) < 0) axes[2].negate();
    // Extents in this basis
    let min0=Infinity,min1=Infinity,min2=Infinity,max0=-Infinity,max1=-Infinity,max2=-Infinity;
    for (const p of pts){const d=new THREE.Vector3().subVectors(p,mean);const a0=d.dot(axes[0]);const a1=d.dot(axes[1]);const a2=d.dot(axes[2]);if(a0<min0)min0=a0;if(a0>max0)max0=a0;if(a1<min1)min1=a1;if(a1>max1)max1=a1;if(a2<min2)min2=a2;if(a2>max2)max2=a2;}
    const sizes = new THREE.Vector3(max0-min0,max1-min1,max2-min2);
    return { axes, sizes };
}

function buildBestRotationFromBases(srcAxes, dstAxes) {
    // Return rotation matrix R mapping src basis to dst basis
    const perms = [[0,1,2],[0,2,1],[1,0,2],[1,2,0],[2,0,1],[2,1,0]];
    let best = { score: -Infinity, R: new THREE.Matrix4() };
    for (const p of perms) {
        for (const sx of [-1,1]) {
            for (const sy of [-1,1]) {
                const ex = srcAxes[p[0]].clone().multiplyScalar(sx).normalize();
                const ey = srcAxes[p[1]].clone().multiplyScalar(sy).normalize();
                const ez = new THREE.Vector3().crossVectors(ex, ey).normalize(); // right-handed
                const S = new THREE.Matrix4().makeBasis(ex, ey, ez);
                const D = new THREE.Matrix4().makeBasis(dstAxes[0], dstAxes[1], dstAxes[2]);
                const St = new THREE.Matrix4().copy(S).transpose();
                const R = new THREE.Matrix4().multiplyMatrices(D, St);
                // Alignment score = sum of squared dot products of mapped axes
                const score = Math.pow(dstAxes[0].dot(ex),2) + Math.pow(dstAxes[1].dot(ey),2) + Math.pow(dstAxes[2].dot(ez),2);
                if (score > best.score) best = { score, R };
            }
        }
    }
    return best.R;
}

function computeUniformScaleWeighted(targetSize, currentSize) {
    const rx = targetSize.x / Math.max(1e-6, currentSize.x);
    const ry = targetSize.y / Math.max(1e-6, currentSize.y);
    const rz = targetSize.z / Math.max(1e-6, currentSize.z);
    const arr = [rx, rz, rx, rz, ry].sort((a,b)=>a-b); // footprint-biased median
    return arr[Math.floor(arr.length/2)];
}

// --- Persistence helpers ---
function ensurePersistToggle() {
    try {
        // Default ON if not set
        if (localStorage.getItem(PERSIST_ENABLED_KEY) == null) {
            localStorage.setItem(PERSIST_ENABLED_KEY, 'true');
        }
        const list = document.getElementById('structures-list');
        if (!list || !list.parentElement) return;
        let holder = document.getElementById('persistToggleHolder');
        if (!holder) {
            holder = document.createElement('div');
            holder.id = 'persistToggleHolder';
            holder.style.cssText = 'display:flex; align-items:center; gap:6px; margin:4px 0 6px 0; justify-content:flex-end;';
            holder.innerHTML = `
                <label style="font-size:12px; display:flex; align-items:center; gap:6px;">
                    <span>Persistent</span>
                    <input id="persistToggle" type="checkbox" />
                </label>
            `;
            // Insert above the structures list
            list.parentElement.insertBefore(holder, list);
        }
        const cb = document.getElementById('persistToggle');
        cb.checked = (localStorage.getItem(PERSIST_ENABLED_KEY) !== 'false');
        cb.addEventListener('change', () => {
            localStorage.setItem(PERSIST_ENABLED_KEY, cb.checked ? 'true' : 'false');
            if (cb.checked) persistStateIfEnabled();
        });
    } catch (e) { console.warn('persist toggle init failed', e); }
}

function isPersistenceEnabled() {
    return localStorage.getItem(PERSIST_ENABLED_KEY) !== 'false';
}

function persistStateIfEnabled() {
    if (!isPersistenceEnabled()) return;
    try { const state = snapshotPersistentState(); localStorage.setItem(PERSIST_KEY, JSON.stringify(state)); } catch (e) { console.warn('persist failed', e); }
}

function snapshotPersistentState() {
    // saved structures + skins + active indices + gallery items + structure galleries + placed models
    const structures = savedStructures.map(s => ({ id: s.id, name: s.name, data: s.data, thumbnail: s.thumbnail }));
    const skins = {};
    structureIdToSkinUrls.forEach((arr, id) => { skins[id] = Array.from(arr); });
    const skinIdx = {}; activeSkinIndex.forEach((idx, id) => { skinIdx[id] = idx; });
    const gallery = snapshotGalleryState();
    
    // Save structure-specific galleries
    const structureGalleryData = {};
    structureGalleries.forEach((html, structureId) => { structureGalleryData[structureId] = html; });
    
    // Save placed models data (just the glbUrl and structureId, not the actual THREE.js objects)
    const placedModelsData = {};
    placedModelsByStructure.forEach((modelData, structureId) => {
        placedModelsData[structureId] = { glbUrl: modelData.glbUrl };
    });
    
    return { structures, skins, skinIdx, gallery, structureGalleryData, placedModelsData };
}

function snapshotGalleryState() {
    const gallery = document.getElementById('captureGallery');
    if (!gallery) return [];
    const out = [];
    const seenGlbs = new Set();
    gallery.querySelectorAll('.capture-item').forEach(item => {
        const type = item.dataset.type || 'image';
        const label = (item.querySelector('.capture-label')?.textContent || '').trim();
        const img = item.querySelector('img.capture-img');
        const structureId = item.dataset.structureId ? Number(item.dataset.structureId) : undefined;
        if (type === 'tripo' || type === 'localglb') {
            const glbUrl = item.dataset.glb || '';
            if (seenGlbs.has(glbUrl)) return; // skip duplicate GLB entries
            seenGlbs.add(glbUrl);
            out.push({ type: 'tripo', glb: glbUrl, structureId });
        } else if (img) {
            out.push({ type: type === 'flux' ? 'flux' : 'image', src: img.src, label, structureId });
        }
    });
    return out;
}

function restorePersistentState() {
    if (!isPersistenceEnabled()) return;
    try {
        const raw = localStorage.getItem(PERSIST_KEY);
        if (!raw) return;
        const state = JSON.parse(raw);
        // Restore structures
        savedStructures = Array.isArray(state.structures) ? state.structures : [];
        structureIdToSkinUrls = new Map();
        if (state.skins) { Object.keys(state.skins).forEach(k => structureIdToSkinUrls.set(Number(k), state.skins[k])); }
        activeSkinIndex = new Map();
        if (state.skinIdx) { Object.keys(state.skinIdx).forEach(k => activeSkinIndex.set(Number(k), state.skinIdx[k])); }
        // Rebuild scene voxels from saved structures
        rebuildSceneFromSavedStructures();
        updateStructuresMenu();
        // Restore structure-specific galleries
        if (state.structureGalleryData) {
            structureGalleries = new Map();
            Object.keys(state.structureGalleryData).forEach(structureId => {
                structureGalleries.set(Number(structureId), state.structureGalleryData[structureId]);
            });
        }
        
        // Restore placed models (need to recreate the THREE.js objects)
        if (state.placedModelsData) {
            placedModelsByStructure = new Map();
            // Process models asynchronously without blocking the main restoration
            Object.keys(state.placedModelsData).forEach((structureId) => {
                const sid = Number(structureId);
                // Skip if the associated structure was not restored (or no structures exist)
                if (!savedStructures || !savedStructures.some(s => s.id === sid)) return;

                const modelData = state.placedModelsData[structureId];
                if (modelData && modelData.glbUrl) {
                    // Re-place the model for this structure (async but don't block)
                    enableTripoPlacement(modelData.glbUrl, sid).catch(e => {
                        console.warn(`Failed to restore model for structure ${structureId}:`, e);
                    });
                }
            });
        }
        
        // Restore legacy gallery (for backward compatibility)
        if (Array.isArray(state.gallery)) {
            const gallery = document.getElementById('captureGallery');
            if (gallery) gallery.innerHTML = '';
            state.gallery.forEach(it => {
                if (it.type === 'tripo' && it.glb) {
                    // structureId may be missing from older saves; keep undefined
                    attachTripoResult(it.glb, undefined, it.structureId ?? null);
                } else if (it.type === 'flux' && it.src) {
                    // tag with structure if recorded
                    if (it.structureId != null) { const sId = String(it.structureId); }
                    attachFalResult(it.src);
                    const last = gallery.firstElementChild; if (last && it.structureId != null) last.dataset.structureId = String(it.structureId);
                } else if (it.type === 'image' && it.src) {
                    appendGalleryImage(it.label || 'IMAGE', it.src, it.structureId);
                }
            });
        }
    } catch (e) { console.warn('restore failed', e); }
}

function rebuildSceneFromSavedStructures() {
    // Remove existing non-ground voxels
    voxels.forEach(v => {
        scene.remove(v);
        if (v.userData && v.userData.edges) scene.remove(v.userData.edges);
        v.geometry?.dispose?.();
        v.material?.dispose?.();
        if (v.userData?.edges) {
            v.userData.edges.geometry?.dispose?.();
            v.userData.edges.material?.dispose?.();
        }
    });
    voxels = [];
    // Recreate from saved structures
    savedStructures.forEach(s => {
        (s.data || []).forEach(vd => {
            const p = Array.isArray(vd.position) ? vd.position : vd.position?.toArray?.() || vd.position;
            if (!p) return;
            createVoxelAtPosition(Math.round(p[0]), Math.round(p[1]), Math.round(p[2]), vd.color || 0xe0e0e0);
        });
    });
}

function createVoxelAtPosition(x, y, z, baseColor) {
    const geometry = new THREE.BoxGeometry(voxelSize, voxelSize, voxelSize);
    const material = new THREE.MeshPhongMaterial({ 
        color: baseColor || 0xe0e0e0,
        emissive: 0x000000,
        emissiveIntensity: 0
    });
    const cube = new THREE.Mesh(geometry, material);
    cube.position.set(x, y, z);
    cube.userData = { type: 'voxel', selected: false, baseColor: baseColor || 0xe0e0e0 };
    // Edges
    const edges = new THREE.EdgesGeometry(geometry);
    const edgeMaterial = new THREE.LineBasicMaterial({ color: 0x000000, linewidth: 1 });
    const edgeLines = new THREE.LineSegments(edges, edgeMaterial);
    edgeLines.position.copy(cube.position);
    cube.userData.edges = edgeLines;
    scene.add(edgeLines);
    updateVoxelColor(cube);
    cube.castShadow = true; cube.receiveShadow = true;
    scene.add(cube);
    voxels.push(cube);
}
// --- end persistence ---

function deleteStructureById(structureId) {
    // Exit focus if needed
    if (focusedStructure && focusedStructure.id === structureId) {
        if (focusMode) exitFocusMode();
        focusedStructure = null;
        focusedStructureVoxels.clear();
    }
    // Remove voxels belonging to the structure
    const s = savedStructures.find(ss => ss.id === structureId);
    if (s && s.data) {
        const posSet = new Set();
        s.data.forEach(v => {
            const p = Array.isArray(v.position) ? v.position : v.position?.toArray?.() || v.position;
            if (!p) return; posSet.add(key(Math.round(p[0]), Math.round(p[1]), Math.round(p[2])));
        });
        const toRemove = [];
        voxels.forEach(vx => { if (posSet.has(key(Math.round(vx.position.x), Math.round(vx.position.y), Math.round(vx.position.z)))) toRemove.push(vx); });
        toRemove.forEach(vx => {
            scene.remove(vx);
            if (vx.userData?.edges) { scene.remove(vx.userData.edges); vx.userData.edges.geometry?.dispose?.(); vx.userData.edges.material?.dispose?.(); }
            vx.geometry?.dispose?.(); vx.material?.dispose?.();
            const idx = voxels.indexOf(vx); if (idx >= 0) voxels.splice(idx, 1);
        });
    }
    // Remove skins and overlay
    structureIdToSkinUrls.delete(structureId);
    activeSkinIndex.delete(structureId);
    const el = skinEls.get(structureId); if (el) { el.remove(); skinEls.delete(structureId); }
    skinStates.delete(structureId);
    // Remove gallery items with this structureId
    const gallery = document.getElementById('captureGallery');
    if (gallery) {
        [...gallery.querySelectorAll('.capture-item')].forEach(it => {
            if (Number(it.dataset.structureId) === structureId) it.remove();
        });
    }
    // Remove from savedStructures
    savedStructures = savedStructures.filter(ss => ss.id !== structureId);
    updateStructuresMenu();
    persistStateIfEnabled();
    showToast('Structure deleted', 'success');
}

// Step-by-step placement visualization system (DEPRECATED - TO BE REMOVED)
class PlacementVisualizer {
    constructor() {
        this.steps = [];
        this.currentStepIndex = 0;
        this.visualizer = document.getElementById('placementVisualizer');
        this.stepTitle = document.getElementById('stepTitle');
        this.stepDescription = document.getElementById('stepDescription');
        this.stepValues = document.getElementById('stepValues');
        this.currentStepSpan = document.getElementById('currentStep');
        this.totalStepsSpan = document.getElementById('totalSteps');
        this.prevBtn = document.getElementById('prevStepBtn');
        this.nextBtn = document.getElementById('nextStepBtn');
        this.closeBtn = this.visualizer.querySelector('.close-visualizer');
        
        this.bindEvents();
    }
    
    bindEvents() {
        this.prevBtn.addEventListener('click', () => this.previousStep());
        this.nextBtn.addEventListener('click', () => this.nextStep());
        this.closeBtn.addEventListener('click', () => this.hide());
        
        // Keyboard navigation
        document.addEventListener('keydown', (e) => {
            if (this.visualizer.style.display === 'none') return;
            if (e.key === 'ArrowLeft') this.previousStep();
            else if (e.key === 'ArrowRight') this.nextStep();
            else if (e.key === 'Escape') this.hide();
        });
    }
    
    show(steps) {
        this.steps = steps;
        this.currentStepIndex = 0;
        this.visualizer.style.display = 'block';
        this.totalStepsSpan.textContent = steps.length;
        this.updateDisplay();
    }
    
    hide() {
        this.visualizer.style.display = 'none';
        this.clearVisualIndicators();
    }
    
    nextStep() {
        if (this.currentStepIndex < this.steps.length - 1) {
            this.currentStepIndex++;
            this.updateDisplay();
        }
    }
    
    previousStep() {
        if (this.currentStepIndex > 0) {
            this.currentStepIndex--;
            this.updateDisplay();
        }
    }
    
    updateDisplay() {
        const step = this.steps[this.currentStepIndex];
        
        this.stepTitle.textContent = step.title;
        this.stepDescription.textContent = step.description;
        this.stepValues.textContent = step.values || 'No values to display';
        this.currentStepSpan.textContent = this.currentStepIndex + 1;
        
        this.prevBtn.disabled = this.currentStepIndex === 0;
        this.nextBtn.disabled = this.currentStepIndex === this.steps.length - 1;
        
        // Clear previous visual indicators and apply new ones
        this.clearVisualIndicators();
        if (step.visualCallback) {
            step.visualCallback();
        }
    }
    
    clearVisualIndicators() {
        document.querySelectorAll('.placement-indicator').forEach(el => el.remove());
    }
    
    // Helper method to create visual indicators in the 3D scene
    addVisualIndicator(type, position, label, color = 0xff4444) {
        const indicator = document.createElement('div');
        indicator.className = `placement-indicator placement-${type}`;
        
        if (type === 'box') {
            indicator.style.position = 'absolute';
            indicator.style.border = `2px solid #${color.toString(16).padStart(6, '0')}`;
            indicator.style.background = `rgba(${(color >> 16) & 255}, ${(color >> 8) & 255}, ${color & 255}, 0.1)`;
            indicator.style.pointerEvents = 'none';
        } else if (type === 'arrow') {
            indicator.className += ' placement-arrow';
        }
        
        if (label) {
            const labelEl = document.createElement('div');
            labelEl.className = 'placement-label';
            labelEl.textContent = label;
            indicator.appendChild(labelEl);
        }
        
        document.body.appendChild(indicator);
        return indicator;
    }
}

// Global instance
const placementVisualizer = new PlacementVisualizer();

// Interactive step-by-step placement function
async function enableTripoPlacementWithVisualization(glbUrl, structureId = null) {
    // Check if this specific structure already has a model
    if (structureId && placedModelsByStructure.has(structureId)) {
        alert('This structure already has a 3D model placed. Remove the existing model first.');
        return;
    }
    
    // Create the interactive placement controller
    const controller = new InteractivePlacementController(glbUrl, structureId);
    await controller.initialize();
    controller.show();
}

// Interactive placement controller that performs each step when navigating
class InteractivePlacementController {
    constructor(glbUrl, structureId) {
        this.glbUrl = glbUrl;
        this.structureId = structureId;
        this.currentStep = 0;
        this.gltfRoot = null;
        this.modelGroup = null;
        this.bounds = null;
        this.structureSize = null;
        this.targetCenter = null;
        this.modelBox = null;
        this.modelSize = null;
        this.modelCenter = null;
        this.rotationTestData = [];
        this.bestRotation = 0;
        this.bestScore = Infinity;
        this.uniformScale = 1;
        
        // Get UI elements
        this.visualizer = document.getElementById('placementVisualizer');
        this.stepTitle = document.getElementById('stepTitle');
        this.stepDescription = document.getElementById('stepDescription');
        this.stepValues = document.getElementById('stepValues');
        this.currentStepSpan = document.getElementById('currentStep');
        this.totalStepsSpan = document.getElementById('totalSteps');
        this.prevBtn = document.getElementById('prevStepBtn');
        this.nextBtn = document.getElementById('nextStepBtn');
        this.closeBtn = this.visualizer.querySelector('.close-visualizer');
        
        this.bindEvents();
        this.totalStepsSpan.textContent = '11';
    }
    
    bindEvents() {
        this.prevBtn.addEventListener('click', () => this.previousStep());
        this.nextBtn.addEventListener('click', () => this.nextStep());
        this.closeBtn.addEventListener('click', () => this.close());
        
        // Keyboard navigation
        this.keyHandler = (e) => {
            if (this.visualizer.style.display === 'none') return;
            if (e.key === 'ArrowLeft') this.previousStep();
            else if (e.key === 'ArrowRight') this.nextStep();
            else if (e.key === 'Escape') this.close();
        };
        document.addEventListener('keydown', this.keyHandler);
    }
    
    async initialize() {
        // Pre-load the model and compute initial data
        this.gltfRoot = await loadGLTFRoot(this.glbUrl);
        this.bounds = this.structureId ? computeStructureBoundsById(this.structureId) : computePlacementBounds();
        this.structureSize = new THREE.Vector3(
            this.bounds.max.x - this.bounds.min.x,
            this.bounds.max.y - this.bounds.min.y,
            this.bounds.max.z - this.bounds.min.z
        );
        this.targetCenter = new THREE.Vector3().addVectors(this.bounds.min, this.bounds.max).multiplyScalar(0.5);
    }
    
    show() {
        this.visualizer.style.display = 'block';
        this.executeStep(0);
    }
    
    close() {
        this.visualizer.style.display = 'none';
        document.removeEventListener('keydown', this.keyHandler);
        
        // Clean up any incomplete placement
        if (this.modelGroup && this.currentStep < 10) {
            scene.remove(this.modelGroup);
        }
    }
    
    nextStep() {
        if (this.currentStep < 10) {
            this.currentStep++;
            this.executeStep(this.currentStep);
        }
    }
    
    previousStep() {
        if (this.currentStep > 0) {
            this.currentStep--;
            this.executeStep(this.currentStep);
        }
    }
    
    executeStep(stepIndex) {
        this.currentStepSpan.textContent = stepIndex + 1;
        this.prevBtn.disabled = stepIndex === 0;
        this.nextBtn.disabled = stepIndex === 10;
        
        switch (stepIndex) {
            case 0: this.step1_LoadModel(); break;
            case 1: this.step2_AnalyzeStructure(); break;
            case 2: this.step3_ResetTransforms(); break;
            case 3: this.step4_MeasureModel(); break;
            case 4: this.step5_CenterAtOrigin(); break;
            case 5: this.step6_CalculateScale(); break;
            case 6: this.step7_ApplyScale(); break;
            case 7: this.step8_FindOptimalRotation(); break;
            case 8: this.step9_ApplyRotation(); break;
            case 9: this.step10_FinalPosition(); break;
            case 10: this.step11_Complete(); break;
        }
    }
    
    step1_LoadModel() {
        this.stepTitle.textContent = "Step 1: Loading 3D Model";
        this.stepDescription.textContent = "Loading the GLB model file and preparing it for placement analysis.";
        this.stepValues.textContent = `Model URL: ${this.glbUrl}\nStructure ID: ${this.structureId || 'Current focused/selected'}\nModel loaded: ✓`;
    }
    
    step2_AnalyzeStructure() {
        this.stepTitle.textContent = "Step 2: Analyze Target Structure";
        this.stepDescription.textContent = "Computing the bounding box and dimensions of the target structure where the model will be placed.";
        this.stepValues.textContent = `Structure bounds:
Min: (${this.bounds.min.x.toFixed(1)}, ${this.bounds.min.y.toFixed(1)}, ${this.bounds.min.z.toFixed(1)})
Max: (${this.bounds.max.x.toFixed(1)}, ${this.bounds.max.y.toFixed(1)}, ${this.bounds.max.z.toFixed(1)})
Size: ${this.structureSize.x.toFixed(1)} × ${this.structureSize.y.toFixed(1)} × ${this.structureSize.z.toFixed(1)}
Center: (${this.targetCenter.x.toFixed(1)}, ${this.targetCenter.y.toFixed(1)}, ${this.targetCenter.z.toFixed(1)})`;
    }
    
    step3_ResetTransforms() {
        // Actually reset the transforms
        this.gltfRoot.rotation.set(0, 0, 0);
        this.gltfRoot.scale.set(1, 1, 1);
        this.gltfRoot.position.set(0, 0, 0);
        this.gltfRoot.updateMatrixWorld(true);
        
        // Add to scene temporarily to show it
        if (!this.modelGroup) {
            this.modelGroup = new THREE.Group();
            this.modelGroup.userData.isTripoModel = true;
            this.modelGroup.userData.structureId = this.structureId;
            this.modelGroup.add(this.gltfRoot);
            scene.add(this.modelGroup);
        }
        
        this.stepTitle.textContent = "Step 3: Reset Model Transforms";
        this.stepDescription.textContent = "Resetting the model to its original position, rotation, and scale for baseline measurements. Model is now visible in scene.";
        this.stepValues.textContent = `Position: (0, 0, 0)
Rotation: (0°, 0°, 0°)
Scale: (1, 1, 1)
Model added to scene: ✓`;
    }
    
    step4_MeasureModel() {
        this.modelBox = new THREE.Box3().setFromObject(this.gltfRoot);
        this.modelSize = this.modelBox.getSize(new THREE.Vector3());
        this.modelCenter = this.modelBox.getCenter(new THREE.Vector3());
        
        this.stepTitle.textContent = "Step 4: Measure Original Model";
        this.stepDescription.textContent = "Computing the model's original bounding box and dimensions before any transformations.";
        this.stepValues.textContent = `Model bounds:
Min: (${this.modelBox.min.x.toFixed(2)}, ${this.modelBox.min.y.toFixed(2)}, ${this.modelBox.min.z.toFixed(2)})
Max: (${this.modelBox.max.x.toFixed(2)}, ${this.modelBox.max.y.toFixed(2)}, ${this.modelBox.max.z.toFixed(2)})
Size: ${this.modelSize.x.toFixed(2)} × ${this.modelSize.y.toFixed(2)} × ${this.modelSize.z.toFixed(2)}
Center: (${this.modelCenter.x.toFixed(2)}, ${this.modelCenter.y.toFixed(2)}, ${this.modelCenter.z.toFixed(2)})`;
    }
    
    step5_CenterAtOrigin() {
        // Actually center the model
        this.gltfRoot.position.sub(this.modelCenter);
        this.gltfRoot.updateMatrixWorld(true);
        
        const modelBoxAtOrigin = new THREE.Box3().setFromObject(this.gltfRoot);
        const modelSizeAtOrigin = modelBoxAtOrigin.getSize(new THREE.Vector3());
        
        this.stepTitle.textContent = "Step 5: Center Model at Origin";
        this.stepDescription.textContent = "Moving the model so its center is at the world origin (0,0,0) for stable transformations. Watch the model move!";
        this.stepValues.textContent = `Offset applied: (${(-this.modelCenter.x).toFixed(2)}, ${(-this.modelCenter.y).toFixed(2)}, ${(-this.modelCenter.z).toFixed(2)})
New position: (${this.gltfRoot.position.x.toFixed(2)}, ${this.gltfRoot.position.y.toFixed(2)}, ${this.gltfRoot.position.z.toFixed(2)})
Size at origin: ${modelSizeAtOrigin.x.toFixed(2)} × ${modelSizeAtOrigin.y.toFixed(2)} × ${modelSizeAtOrigin.z.toFixed(2)}`;
    }
    
    step8_FindOptimalRotation() {
        // Get the current scaled model dimensions
        const currentBox = new THREE.Box3().setFromObject(this.gltfRoot);
        const currentSize = currentBox.getSize(new THREE.Vector3());
        
        // Target structure dimensions
        const targetX = this.structureSize.x + 1;
        const targetZ = this.structureSize.z + 1;
        
        // Test only the 4 cardinal directions: 0°, 90°, 180°, 270°
        // This avoids weird in-between rotations and focuses on logical orientations
        const testRotations = [0, 90, 180, 270];
        this.bestRotation = 0;
        this.bestScore = Infinity;
        let bestRotationDegrees = 0;
        
        let rotationResults = [];
        
        for (const degrees of testRotations) {
            const rotation = degrees * Math.PI / 180;
            this.gltfRoot.rotation.y = rotation;
            this.gltfRoot.updateMatrixWorld(true);
            
            const testBox = new THREE.Box3().setFromObject(this.gltfRoot);
            const testSize = testBox.getSize(new THREE.Vector3());
            
            // Calculate how well this rotation matches the target dimensions
            const xError = Math.abs(testSize.x - targetX);
            const zError = Math.abs(testSize.z - targetZ);
            const totalError = xError + zError;
            
            rotationResults.push({
                degrees: degrees,
                rotation: rotation,
                error: totalError,
                modelX: testSize.x,
                modelZ: testSize.z,
                description: `${degrees}°: Model ${testSize.x.toFixed(1)}×${testSize.z.toFixed(1)} vs Target ${targetX.toFixed(1)}×${targetZ.toFixed(1)} = Error ${totalError.toFixed(3)}`
            });
            
            // Prefer 0° rotation if errors are very close (within 0.1)
            const isBetter = totalError < this.bestScore;
            const isSimilarButPreferNoRotation = (Math.abs(totalError - this.bestScore) < 0.1 && degrees === 0);
            
            if (isBetter || isSimilarButPreferNoRotation) {
                this.bestScore = totalError;
                this.bestRotation = rotation;
                bestRotationDegrees = degrees;
            }
        }
        
        // Reset to 0 rotation to show the search process
        this.gltfRoot.rotation.y = 0;
        this.gltfRoot.updateMatrixWorld(true);
        
        // Sort results by error for display
        rotationResults.sort((a, b) => a.error - b.error);
        
        this.stepTitle.textContent = "Step 8: Finding Optimal Rotation";
        this.stepDescription.textContent = "Testing the 4 cardinal rotations (0°, 90°, 180°, 270°) to find the best alignment with the structure's footprint.";
        this.stepValues.textContent = `Model footprint at different rotations:
${rotationResults.map(r => r.description).join('\n')}

✅ Best rotation: ${bestRotationDegrees}° (error: ${this.bestScore.toFixed(3)})

This avoids weird angles and uses logical orientations.`;
    }
    
    step9_ApplyRotation() {
        // Actually apply the optimal rotation
        this.gltfRoot.rotation.y = this.bestRotation;
        this.gltfRoot.updateMatrixWorld(true);
        
        const rotatedBox = new THREE.Box3().setFromObject(this.gltfRoot);
        const rotatedSize = rotatedBox.getSize(new THREE.Vector3());
        
        const appliedDegrees = (this.bestRotation * 180 / Math.PI);
        
        this.stepTitle.textContent = "Step 9: Apply Optimal Rotation";
        this.stepDescription.textContent = "Applying the best rotation found. If this looks wrong, you can manually adjust it later using the transform controls.";
        this.stepValues.textContent = `✅ Applied rotation: ${appliedDegrees.toFixed(0)}°

Final model footprint: ${rotatedSize.x.toFixed(2)} × ${rotatedSize.z.toFixed(2)}
Target structure footprint: ${(this.structureSize.x + 1).toFixed(1)} × ${(this.structureSize.z + 1).toFixed(1)}

If this doesn't look right visually:
- Complete the placement process
- Enter focus mode (F key)
- Use the rotation tool to manually adjust

The algorithm picks the mathematically best fit,
but sometimes visual alignment is more important!`;
    }
    
    step6_CalculateScale() {
        const modelBoxAtOrigin = new THREE.Box3().setFromObject(this.gltfRoot);
        const modelSizeAtOrigin = modelBoxAtOrigin.getSize(new THREE.Vector3());
        
        const actualStructureSize = new THREE.Vector3(
            this.structureSize.x + 1,
            this.structureSize.y + 1,
            this.structureSize.z + 1
        );
        
        const scaleX = actualStructureSize.x / modelSizeAtOrigin.x;
        const scaleY = actualStructureSize.y / modelSizeAtOrigin.y;
        const scaleZ = actualStructureSize.z / modelSizeAtOrigin.z;
        
        const scales = [scaleX, scaleY, scaleZ].sort((a, b) => a - b);
        this.uniformScale = scales[1]; // median
        
        this.stepTitle.textContent = "Step 6: Calculate Scale Factor";
        this.stepDescription.textContent = "Computing the scale needed to match the model size to the structure size. Using median scale for best overall fit.";
        this.stepValues.textContent = `Individual scales:
X-axis: ${scaleX.toFixed(3)}
Y-axis: ${scaleY.toFixed(3)}
Z-axis: ${scaleZ.toFixed(3)}
Median scale: ${scales[1].toFixed(3)}
Final scale: ${this.uniformScale.toFixed(3)}`;
    }
    
    step7_ApplyScale() {
        // Actually apply the scale
        this.gltfRoot.scale.setScalar(this.uniformScale);
        this.gltfRoot.updateMatrixWorld(true);
        
        const scaledBox = new THREE.Box3().setFromObject(this.gltfRoot);
        const scaledSize = scaledBox.getSize(new THREE.Vector3());
        
        this.stepTitle.textContent = "Step 7: Apply Scale";
        this.stepDescription.textContent = "Scaling the model uniformly to match the structure dimensions. Watch the model resize!";
        this.stepValues.textContent = `Scale applied: ${this.uniformScale.toFixed(3)}
Scaled model size: ${scaledSize.x.toFixed(2)} × ${scaledSize.y.toFixed(2)} × ${scaledSize.z.toFixed(2)}`;
    }
    
    step10_FinalPosition() {
        const scaledRotatedBox = new THREE.Box3().setFromObject(this.gltfRoot);
        const yOffset = this.bounds.min.y - scaledRotatedBox.min.y;
        const finalPosition = new THREE.Vector3(
            this.targetCenter.x,
            yOffset,
            this.targetCenter.z
        );
        
        // Actually move to final position
        this.gltfRoot.position.copy(finalPosition);
        
        this.stepTitle.textContent = "Step 10: Final Positioning";
        this.stepDescription.textContent = "Moving the scaled and rotated model to the structure's location. Aligning the bottom of the model with the structure's base. Watch the model move to its final position!";
        this.stepValues.textContent = `Y offset calculation:
Structure base Y: ${this.bounds.min.y.toFixed(2)}
Model base Y (before move): ${scaledRotatedBox.min.y.toFixed(2)}
Y offset: ${yOffset.toFixed(2)}

Final position: (${finalPosition.x.toFixed(2)}, ${finalPosition.y.toFixed(2)}, ${finalPosition.z.toFixed(2)})

Model placement complete! The model is now:
- Correctly scaled to structure size
- Optimally rotated for best shape alignment  
- Positioned exactly over the target structure`;
    }
    
    step11_Complete() {
        // Store the model in the tracking map
        placedModelsByStructure.set(this.structureId, {
            group: this.modelGroup,
            glbUrl: this.glbUrl
        });
        
        // Set as active model if this is for the focused structure
        if (focusedStructure && this.structureId === focusedStructure.id) {
            tripoModelGroup = this.modelGroup;
            tripoPlacementEnabled = true;
            
            // Show transform controls in focus mode
            if (focusMode) {
                attachTripoTransformControls(tripoModelGroup);
            }
        }
        
        // Update focus mode visibility if active
        if (focusMode) {
            updateFocusModeVisibility();
        }
        
        this.stepTitle.textContent = "Step 11: Complete - Model Placed";
        this.stepDescription.textContent = "The 3D model has been successfully placed in the scene with optimal alignment to the structure.";
        this.stepValues.textContent = `Model group created and added to scene
Structure ID: ${this.structureId}
Model tracking: Active
Transform controls: ${focusMode ? 'Available' : 'Hidden (enter focus mode to adjust)'}
Placement complete! ✓`;
    }
}

function setGridOverlayVisible(visible) {
    scene.children.forEach(child => {
        const isGridOverlay = child.userData && (child.userData.isGridHelper || child.userData.isGridPlane);
        if (isGridOverlay) child.visible = visible;
    });
}

function removeFoundation() {
    if (foundationGroup) {
        scene.remove(foundationGroup);
        foundationGroup.traverse(n=>{ if(n.isMesh){ n.geometry?.dispose?.(); n.material?.dispose?.(); }});
        foundationGroup = null;
    }
}

function createOrUpdateFoundation(boundsOverride = null, camForCorner = null) {
    // Remove any previous foundation
    removeFoundation();

    // Use available bounds or compute from current structure
    const bounds = boundsOverride || computeFocusedStructureBounds();
    if (!bounds) return;

    const unit = voxelSize; // 1 segment
    const height = 0.5 * unit; // 0.5 segment high

    // Compute footprint bounding box across ALL voxels in XZ (ignore Y)
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    let foundAny = false;
    focusedStructureVoxels.forEach(v => {
        const x = Math.round(v.position.x);
        const z = Math.round(v.position.z);
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (z < minZ) minZ = z;
        if (z > maxZ) maxZ = z;
        foundAny = true;
    });
    if (!foundAny || !isFinite(minX)) return;

    // Take all segments beneath the footprint bounding box AND their outer neighbors
    const rMinX = minX - 1;
    const rMaxX = maxX + 1;
    const rMinZ = minZ - 1;
    const rMaxZ = maxZ + 1;

    // Remove the corner opposite along the Z axis (NE corner in world axes)
    const skipKey = `${rMaxX}|${rMaxZ}`;

    const g = new THREE.BoxGeometry(unit, height, unit);
    const mat = new THREE.MeshPhongMaterial({ color: 0xd8e1ff });
    foundationGroup = new THREE.Group();

    for (let x = rMinX; x <= rMaxX; x++) {
        for (let z = rMinZ; z <= rMaxZ; z++) {
            if (`${x}|${z}` === skipKey) continue; // remove the bottom-right corner cell
            const m = new THREE.Mesh(g, mat);
            // Center Y so top face is at top of ground grid (y = voxelSize * 0.5)
            const topY = voxelSize * 0.5;
            m.position.set(x, topY - height * 0.5, z);
            foundationGroup.add(m);
        }
    }

    scene.add(foundationGroup);
}

function removeTreeMarker() {
    if (treeMarkerGroup) {
        scene.remove(treeMarkerGroup);
        treeMarkerGroup.traverse(n=>{ if(n.isMesh){ n.geometry?.dispose?.(); n.material?.dispose?.(); }});
        treeMarkerGroup = null;
    }
}

function positionTreeMarker(bounds, cam) {
    if (!treeMarkerGroup || !cam || !bounds) return;
    const unit = voxelSize * 0.1;
    // Use the same NDC raycast approach as capture for consistent placement
    const raycaster = new THREE.Raycaster();
    const ndc = new THREE.Vector2(-0.68, -0.8); // bottom-left but not cropped
    raycaster.setFromCamera(ndc, cam);
    const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -bounds.min.y);
    const pos = new THREE.Vector3();
    raycaster.ray.intersectPlane(groundPlane, pos);
    // Push outward from footprint if we landed inside
    const margin = 0.4;
    const cx = (bounds.min.x + bounds.max.x) * 0.5;
    const cz = (bounds.min.z + bounds.max.z) * 0.5;
    const inside = (pos.x > bounds.min.x - margin && pos.x < bounds.max.x + margin && pos.z > bounds.min.z - margin && pos.z < bounds.max.z + margin);
    if (inside) {
        const pushDir = new THREE.Vector3(pos.x - cx, 0, pos.z - cz).normalize();
        if (pushDir.lengthSq() < 1e-6) pushDir.set(-1,0,1).normalize();
        pos.add(pushDir.multiplyScalar(margin + 0.6));
    }
    // Slight inward nudge from extreme left relative to camera
    const center = new THREE.Vector3().addVectors(bounds.min, bounds.max).multiplyScalar(0.5);
    const camDir = center.clone().sub(cam.position).normalize();
    const right = new THREE.Vector3().crossVectors(camDir, new THREE.Vector3(0,1,0)).normalize();
    pos.add(right.multiplyScalar(0.2));
    pos.y = bounds.min.y + unit*0.5;
    treeMarkerGroup.position.copy(pos);
}

function createOrUpdateTreeMarker(boundsOverride = null, camForPlacement = null) {
    // Remove any existing tree and do nothing (tree disabled)
    removeTreeMarker();
    return;
}

// Removed duplicate Fit button listener - it's properly attached in showTransformPanel()

function computeStructureFoundationInfo(structureId) {
    // Compute foundation info for a structure, identifying the missing corner
    const s = savedStructures.find(ss => ss.id === structureId);
    if (!s || !s.data || s.data.length === 0) {
        // Try to compute from focused structure voxels if available
        if (focusedStructure && focusedStructure.id === structureId && focusedStructureVoxels.length > 0) {
            return computeFoundationFromVoxels(focusedStructureVoxels);
        }
        return null;
    }
    
    // Compute bounds and base Y level
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    
    s.data.forEach(v => {
        const p = Array.isArray(v.position) ? v.position : v.position?.toArray?.() || v.position;
        if (!p) return;
        const x = Math.round(p[0]);
        const y = Math.round(p[1]);
        const z = Math.round(p[2]);
        minX = Math.min(minX, x); 
        minY = Math.min(minY, y); 
        minZ = Math.min(minZ, z);
        maxX = Math.max(maxX, x); 
        maxY = Math.max(maxY, y); 
        maxZ = Math.max(maxZ, z);
    });
    
    if (!isFinite(minX)) return null;
    
    // The foundation is at the base level (minY)
    const baseY = minY;
    
    // Create occupancy map for the base level
    const occupancy = new Set();
    s.data.forEach(v => {
        const p = Array.isArray(v.position) ? v.position : v.position?.toArray?.() || v.position;
        if (!p) return;
        const x = Math.round(p[0]);
        const y = Math.round(p[1]);
        const z = Math.round(p[2]);
        
        // Only consider voxels at or near the base level for foundation
        if (Math.abs(y - baseY) < voxelSize * 0.5) {
            occupancy.add(`${x}|${z}`);
        }
    });
    
    // Determine the rectangular bounds of the foundation
    let rMinX = Infinity, rMaxX = -Infinity, rMinZ = Infinity, rMaxZ = -Infinity;
    occupancy.forEach(key => {
        const [x, z] = key.split('|').map(Number);
        rMinX = Math.min(rMinX, x);
        rMaxX = Math.max(rMaxX, x);
        rMinZ = Math.min(rMinZ, z);
        rMaxZ = Math.max(rMaxZ, z);
    });
    
    // Check which corner is actually missing
    const corners = [
        { x: rMinX, z: rMinZ, name: 'SW' },
        { x: rMinX, z: rMaxZ, name: 'NW' },
        { x: rMaxX, z: rMinZ, name: 'SE' },
        { x: rMaxX, z: rMaxZ, name: 'NE' }
    ];
    
    let missing = null;
    for (const corner of corners) {
        if (!occupancy.has(`${corner.x}|${corner.z}`)) {
            missing = { x: corner.x, z: corner.z };
            console.log('Structure missing corner:', corner.name, 'at', corner.x, corner.z);
            break;
        }
    }
    
    // If no corner is missing, default to NE
    if (!missing) {
        missing = { x: rMaxX, z: rMaxZ };
        console.log('No missing corner detected, defaulting to NE');
    }
    
    return {
        baseY: baseY,
        rMinX: rMinX,
        rMaxX: rMaxX,
        rMinZ: rMinZ,
        rMaxZ: rMaxZ,
        missing: missing,
        occupancy: occupancy,
        bounds: { min: new THREE.Vector3(minX, minY, minZ), max: new THREE.Vector3(maxX, maxY, maxZ) }
    };
}

function computeFoundationFromVoxels(voxels) {
    // Compute foundation info from actual voxels in the scene
    if (!voxels || voxels.length === 0) return null;
    
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    
    voxels.forEach(voxel => {
        const x = Math.round(voxel.position.x);
        const y = Math.round(voxel.position.y);
        const z = Math.round(voxel.position.z);
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        minZ = Math.min(minZ, z);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
        maxZ = Math.max(maxZ, z);
    });
    
    if (!isFinite(minX)) return null;
    
    const baseY = minY;
    const occupancy = new Set();
    
    voxels.forEach(voxel => {
        const x = Math.round(voxel.position.x);
        const y = Math.round(voxel.position.y);
        const z = Math.round(voxel.position.z);
        
        if (Math.abs(y - baseY) < voxelSize * 0.5) {
            occupancy.add(`${x}|${z}`);
        }
    });
    
    // Determine rectangular bounds
    let rMinX = Infinity, rMaxX = -Infinity, rMinZ = Infinity, rMaxZ = -Infinity;
    occupancy.forEach(key => {
        const [x, z] = key.split('|').map(Number);
        rMinX = Math.min(rMinX, x);
        rMaxX = Math.max(rMaxX, x);
        rMinZ = Math.min(rMinZ, z);
        rMaxZ = Math.max(rMaxZ, z);
    });
    
    // Check which corner is actually missing
    const corners = [
        { x: rMinX, z: rMinZ, name: 'SW' },
        { x: rMinX, z: rMaxZ, name: 'NW' },
        { x: rMaxX, z: rMinZ, name: 'SE' },
        { x: rMaxX, z: rMaxZ, name: 'NE' }
    ];
    
    let missing = null;
    for (const corner of corners) {
        if (!occupancy.has(`${corner.x}|${corner.z}`)) {
            missing = { x: corner.x, z: corner.z };
            console.log('Voxels missing corner:', corner.name, 'at', corner.x, corner.z);
            break;
        }
    }
    
    // If no corner is missing, default to NE
    if (!missing) {
        missing = { x: rMaxX, z: rMaxZ };
        console.log('No missing corner detected in voxels, defaulting to NE');
    }
    
    return {
        baseY: baseY,
        rMinX: rMinX,
        rMaxX: rMaxX,
        rMinZ: rMinZ,
        rMaxZ: rMaxZ,
        missing: missing,
        occupancy: occupancy,
        bounds: { min: new THREE.Vector3(minX, minY, minZ), max: new THREE.Vector3(maxX, maxY, maxZ) }
    };
}

function buildStructureFoundationCells(sInfo) {
    // Return Set of "x|z" cells occupied by the structure foundation idealization
    const cells = new Set();
    for (let x = sInfo.rMinX; x <= sInfo.rMaxX; x++) {
        for (let z = sInfo.rMinZ; z <= sInfo.rMaxZ; z++) {
            if (x === sInfo.missing.x && z === sInfo.missing.z) continue;
            cells.add(`${x}|${z}`);
        }
    }
    return cells;
}

function computeYawAndScaleFromEdges(missingModel, boundsModel, sInfo) {
    // Build model edge vectors from the missing corner to its two adjacent corners
    const mm = new THREE.Vector2(missingModel.x, missingModel.z);
    const bm = boundsModel;
    const adjZ = (missingModel.z === bm.minZ ? bm.maxZ : bm.minZ);
    const adjX = (missingModel.x === bm.minX ? bm.maxX : bm.minX);
    const vA = new THREE.Vector2(missingModel.x, adjZ).sub(mm); // constant X edge
    const vB = new THREE.Vector2(adjX, missingModel.z).sub(mm); // constant Z edge
    if (vA.lengthSq() < 1e-8 || vB.lengthSq() < 1e-8) return null;

    // Target edges from NE missing corner: down (to minZ) and left (to minX)
    const mt = new THREE.Vector2(sInfo.missing.x, sInfo.missing.z);
    const tDown = new THREE.Vector2(sInfo.missing.x, sInfo.rMinZ).sub(mt);
    const tLeft = new THREE.Vector2(sInfo.rMinX, sInfo.missing.z).sub(mt);

    const solveTheta = (src1, src2, dst1, dst2) => {
        // 2D Procrustes rotation: theta = atan2(sum v x t, sum v · t)
        const s = (src1.x * dst1.y - src1.y * dst1.x) + (src2.x * dst2.y - src2.y * dst2.x);
        const c = (src1.x * dst1.x + src1.y * dst1.y) + (src2.x * dst2.x + src2.y * dst2.y);
        return Math.atan2(s, c);
    };
    const mappingA = { theta: solveTheta(vA, vB, tDown, tLeft) };
    const mappingB = { theta: solveTheta(vA, vB, tLeft, tDown) };

    const scoreFor = (theta, src1, src2, dst1, dst2) => {
        const R = (v) => new THREE.Vector2(
            Math.cos(theta) * v.x - Math.sin(theta) * v.y,
            Math.sin(theta) * v.x + Math.cos(theta) * v.y
        );
        const e1 = R(src1).sub(dst1).lengthSq();
        const e2 = R(src2).sub(dst2).lengthSq();
        return e1 + e2;
    };
    const errA = scoreFor(mappingA.theta, vA, vB, tDown, tLeft);
    const errB = scoreFor(mappingB.theta, vA, vB, tLeft, tDown);
    const theta = errA <= errB ? mappingA.theta : mappingB.theta;

    return { theta };
}

function detectModelFoundationMissingCell(root, yEpsilon = 0.2) {
    // Sample vertices near the model's lowest Y to detect base occupancy in XZ; returns { missingX, missingZ, bounds }
    const pos = new THREE.Vector3();
    let minY = Infinity;
    const worldVerts = [];
    root.updateMatrixWorld(true);
    root.traverse(n => {
        if (!n.isMesh || !n.geometry || !n.geometry.attributes || !n.geometry.attributes.position) return;
        const attr = n.geometry.attributes.position;
        for (let i = 0; i < attr.count; i++) {
            pos.fromBufferAttribute(attr, i).applyMatrix4(n.matrixWorld);
            worldVerts.push(pos.clone());
            if (pos.y < minY) minY = pos.y;
        }
    });
    if (!isFinite(minY) || worldVerts.length === 0) return null;
 
    const eps = Math.max(0.05 * voxelSize, yEpsilon * voxelSize);
    const occ = new Set();
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    worldVerts.forEach(p => {
        if (p.y <= minY + eps) {
            const gx = Math.round(p.x);
            const gz = Math.round(p.z);
            occ.add(`${gx}|${gz}`);
            if (gx < minX) minX = gx;
            if (gx > maxX) maxX = gx;
            if (gz < minZ) minZ = gz;
            if (gz > maxZ) maxZ = gz;
        }
    });
    if (!isFinite(minX) || !occ.size) return null;
 
    const corners = [
        { x: minX, z: minZ },
        { x: minX, z: maxZ },
        { x: maxX, z: minZ },
        { x: maxX, z: maxZ }
    ];
    const has = (x, z) => occ.has(`${x}|${z}`);
    let missing = corners.find(c => !has(c.x, c.z));
    if (!missing) {
        // Tie-breaker: pick the corner with least local occupancy in a 2x2 patch
        const localCount = (cx, cz) => {
            let count = 0;
            for (let dx = 0; dx <= 1; dx++) for (let dz = 0; dz <= 1; dz++) {
                if (has(cx - dx, cz - dz)) count++;
            }
            return count;
        };
        let best = { corner: corners[0], score: Infinity };
        for (const c of corners) {
            const score = localCount(c.x, c.z);
            if (score < best.score) best = { corner: c, score };
        }
        missing = best.corner;
    }
    return { missingX: missing.x, missingZ: missing.z, bounds: { minX, maxX, minZ, maxZ }, occupancy: occ };
}

function autoAlignModelToStructureFoundation(obj, structureId) {
    const sInfo = computeStructureFoundationInfo(structureId);
    if (!sInfo) { 
        showToast('Could not compute structure foundation', 'error'); 
        return; 
    }
    
    // Store original position (we'll keep this unchanged)
    const originalPosition = obj.position.clone();
    
    console.log('Structure info:', {
        width: sInfo.rMaxX - sInfo.rMinX + 1,
        depth: sInfo.rMaxZ - sInfo.rMinZ + 1
    });

    // Remove any previous debug visualization
    const oldDebug = scene.getObjectByName('alignmentDebugLine');
    if (oldDebug) scene.remove(oldDebug);
    const oldSWIndicator = scene.getObjectByName('swCornerIndicator');
    if (oldSWIndicator) scene.remove(oldSWIndicator);
    const oldAxisLines = scene.getObjectByName('axisDebugLines');
    if (oldAxisLines) scene.remove(oldAxisLines);

    // Find the rotation that best aligns the model's BOUNDING BOX edges with X/Z axes
    let bestRotation = 0;
    let bestAlignmentScore = Infinity;
    let bestAlignedAxis = 'X'; // Track which axis we're aligning to
    
    // Test rotations from -90 to 90 degrees
    for (let angleDeg = -90; angleDeg <= 90; angleDeg += 5) {
        const angleRad = angleDeg * Math.PI / 180;
        
        // Apply test rotation
        obj.rotation.set(0, angleRad, 0);
        obj.updateMatrixWorld(true);
        
        // Get the model's bounding box at this rotation
        const box = new THREE.Box3().setFromObject(obj);
        const size = box.getSize(new THREE.Vector3());
        
        // The bounding box is always axis-aligned, so we check how "square" it is
        // A perfectly aligned rectangular model will have a bounding box with sides parallel to axes
        // We want to minimize the difference between the model's oriented bounding box and axis-aligned box
        
        // Simple approach: find rotation where bounding box has maximum area
        // (bounding box is smallest when edges align with axes)
        const boxArea = size.x * size.z;
        
        // Or use aspect ratio - when aligned, one dimension should be notably larger
        const aspectRatio = Math.max(size.x / size.z, size.z / size.x);
        
        // Score based on compactness - lower is better
        const alignmentScore = boxArea / aspectRatio;
        
        if (alignmentScore < bestAlignmentScore) {
            bestAlignmentScore = alignmentScore;
            bestRotation = angleRad;
            bestAlignedAxis = size.x > size.z ? 'X' : 'Z';
        }
    }
    
    // Fine-tune the rotation with smaller steps
    const startAngle = bestRotation - 5 * Math.PI / 180;
    const endAngle = bestRotation + 5 * Math.PI / 180;
    
    // Use smaller step size for fine-tuning (0.5 degrees)
    for (let angleRad = startAngle; angleRad <= endAngle; angleRad += Math.PI / 360) {
        obj.rotation.set(0, angleRad, 0);
        obj.updateMatrixWorld(true);
        
        const box = new THREE.Box3().setFromObject(obj);
        const size = box.getSize(new THREE.Vector3());
        
        const boxArea = size.x * size.z;
        const aspectRatio = Math.max(size.x / size.z, size.z / size.x);
        const alignmentScore = boxArea / aspectRatio;
        
        if (alignmentScore < bestAlignmentScore) {
            bestAlignmentScore = alignmentScore;
            bestRotation = angleRad;
            bestAlignedAxis = size.x > size.z ? 'X' : 'Z';
        }
    }
    
    console.log('Best rotation found:', bestRotation * 180 / Math.PI, 'degrees');
    console.log('Aligning edge to axis:', bestAlignedAxis);
    
    // Apply the best rotation
    obj.rotation.y = bestRotation;
    obj.updateMatrixWorld(true);
    
    // No need for additional edge detection - bounding box approach is sufficient
    
    // Visualize the BOUNDING BOX edge with a red line
    const visualBox = new THREE.Box3().setFromObject(obj);
    const boxMin = visualBox.min;
    const boxMax = visualBox.max;
    
    // Determine which edge of the bounding box to show based on alignment
    let points;
    if (bestAlignedAxis === 'X') {
        // Show the edge that runs along X axis (at min Z)
        points = [
            new THREE.Vector3(boxMin.x, boxMin.y, boxMin.z),
            new THREE.Vector3(boxMax.x, boxMin.y, boxMin.z)
        ];
    } else {
        // Show the edge that runs along Z axis (at min X)  
        points = [
            new THREE.Vector3(boxMin.x, boxMin.y, boxMin.z),
            new THREE.Vector3(boxMin.x, boxMin.y, boxMax.z)
        ];
    }
    
    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    const material = new THREE.LineBasicMaterial({ 
        color: 0xff0000, 
        linewidth: 3,
        depthTest: false,
        depthWrite: false
    });
    const line = new THREE.Line(geometry, material);
    line.name = 'alignmentDebugLine';
    scene.add(line);
    
    // Also add spheres at the endpoints for clarity
    const sphereGeometry = new THREE.SphereGeometry(0.2, 16, 16);
    const sphereMaterial = new THREE.MeshBasicMaterial({ 
        color: 0xff0000,
        depthTest: false,
        depthWrite: false
    });
    
    const sphere1 = new THREE.Mesh(sphereGeometry, sphereMaterial);
    sphere1.position.copy(points[0]);
    line.add(sphere1);
    
    const sphere2 = new THREE.Mesh(sphereGeometry, sphereMaterial);
    sphere2.position.copy(points[1]);
    line.add(sphere2);
    
    // Add reference axis lines to show what we're aligning to
    const axisGroup = new THREE.Group();
    axisGroup.name = 'axisDebugLines';
    
    // X-axis line (green)
    const xAxisGeometry = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(boxMin.x - 2, boxMin.y, boxMin.z),
        new THREE.Vector3(boxMax.x + 2, boxMin.y, boxMin.z)
    ]);
    const xAxisMaterial = new THREE.LineBasicMaterial({ 
        color: 0x00ff00, 
        linewidth: 2,
        depthTest: false,
        depthWrite: false
    });
    const xAxisLine = new THREE.Line(xAxisGeometry, xAxisMaterial);
    axisGroup.add(xAxisLine);
    
    // Z-axis line (blue)
    const zAxisGeometry = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(boxMin.x, boxMin.y, boxMin.z - 2),
        new THREE.Vector3(boxMin.x, boxMin.y, boxMax.z + 2)
    ]);
    const zAxisMaterial = new THREE.LineBasicMaterial({ 
        color: 0x0000ff, 
        linewidth: 2,
        depthTest: false,
        depthWrite: false
    });
    const zAxisLine = new THREE.Line(zAxisGeometry, zAxisMaterial);
    axisGroup.add(zAxisLine);
    
    scene.add(axisGroup);
    
    // Calculate angle between bounding box edge and axis
    const edgeDx = points[1].x - points[0].x;
    const edgeDz = points[1].z - points[0].z;
    const edgeAngle = Math.atan2(edgeDz, edgeDx) * 180 / Math.PI;
    
    let angleFromAxis;
    if (bestAlignedAxis === 'X') {
        angleFromAxis = edgeAngle; // Angle from X-axis (0°)
    } else {
        angleFromAxis = edgeAngle - 90; // Angle from Z-axis (90°)
    }
    
    // Apply the final correction to achieve perfect alignment!
    console.log('Edge angle:', edgeAngle, 'degrees from horizontal');
    console.log('Angle from target axis:', angleFromAxis, 'degrees');
    
    if (Math.abs(angleFromAxis) > 0.1) { // If more than 0.1 degrees off
        // Flipping the sign - if it was going the wrong way, this should fix it
        const correctionDegrees = angleFromAxis; // POSITIVE angleFromAxis
        const correctionRadians = correctionDegrees * Math.PI / 180;
        console.log('Applying rotation correction:', correctionDegrees, 'degrees');
        obj.rotation.y += correctionRadians; // Apply the correction
        obj.updateMatrixWorld(true);
        
        // Recalculate the bounding box and update the red line
        const correctedBox = new THREE.Box3().setFromObject(obj);
        const newBoxMin = correctedBox.min;
        const newBoxMax = correctedBox.max;
        
        let newPoints;
        if (bestAlignedAxis === 'X') {
            newPoints = [
                new THREE.Vector3(newBoxMin.x, newBoxMin.y, newBoxMin.z),
                new THREE.Vector3(newBoxMax.x, newBoxMin.y, newBoxMin.z)
            ];
        } else {
            newPoints = [
                new THREE.Vector3(newBoxMin.x, newBoxMin.y, newBoxMin.z),
                new THREE.Vector3(newBoxMin.x, newBoxMin.y, newBoxMax.z)
            ];
        }
        
        // Update the red line geometry
        line.geometry.setFromPoints(newPoints);
        sphere1.position.copy(newPoints[0]);
        sphere2.position.copy(newPoints[1]);
        
        angleFromAxis = 0; // Should now be perfectly aligned
    }
    
    // Add text to show which axis
    console.log(`Red line shows edge aligned to ${bestAlignedAxis} axis`);
    console.log('Final rotation:', obj.rotation.y * 180 / Math.PI, 'degrees');
    console.log('Edge angle from axis after correction:', angleFromAxis, 'degrees');
    showToast(`Edge perfectly aligned to ${bestAlignedAxis} axis!`, 'success');
    
    // Remove the debug visualization after 5 seconds
    setTimeout(() => {
        const debugLine = scene.getObjectByName('alignmentDebugLine');
        if (debugLine) scene.remove(debugLine);
        const axisLines = scene.getObjectByName('axisDebugLines');
        if (axisLines) scene.remove(axisLines);
    }, 5000);
    
    // Now scale the model to match structure HEIGHT
    // Compute structure height (in voxel units)
    const structBounds = sInfo.bounds;
    const structHeight = structBounds.max.y - structBounds.min.y + 1;
    
    // Get current model bounding box after rotation
    const modelBox = new THREE.Box3().setFromObject(obj);
    const modelSize = modelBox.getSize(new THREE.Vector3());
    
    // Compute scale based on Y dimension (height)
    const uniformScale = structHeight / modelSize.y;
    
    console.log('Scaling based on height:', {
        structureHeight: structHeight,
        modelHeight: modelSize.y,
        scale: uniformScale
    });
    
    // Apply uniform scale
    obj.scale.multiplyScalar(uniformScale);
    
    // Keep the original position (centered on structure)
    obj.position.copy(originalPosition);
    
    // Now test 4 cardinal rotations to find which one leaves SW corner empty
    obj.updateMatrixWorld(true);
    const baseRotation = obj.rotation.y;
    let bestOrientation = 0;
    let bestEmptySW = false;
    
    console.log('Testing orientations for missing corner placement...');
    
    // Define corner regions at structure's outer corners (where missing voxels would be)
    const voxelSize = 1.0;
    const corners = {
        SW: { minX: sInfo.rMaxX, maxX: sInfo.rMaxX + voxelSize, 
              minZ: sInfo.rMaxZ, maxZ: sInfo.rMaxZ + voxelSize },
        SE: { minX: sInfo.rMinX - voxelSize, maxX: sInfo.rMinX, 
              minZ: sInfo.rMaxZ, maxZ: sInfo.rMaxZ + voxelSize },
        NW: { minX: sInfo.rMaxX, maxX: sInfo.rMaxX + voxelSize, 
              minZ: sInfo.rMinZ - voxelSize, maxZ: sInfo.rMinZ },
        NE: { minX: sInfo.rMinX - voxelSize, maxX: sInfo.rMinX, 
              minZ: sInfo.rMinZ - voxelSize, maxZ: sInfo.rMinZ }
    };
    
    const raycaster = new THREE.Raycaster();
    const yTolerance = 0.5;
    
    for (let i = 0; i < 4; i++) {
        const testRotation = baseRotation + (i * Math.PI / 2);
        obj.rotation.y = testRotation;
        obj.updateMatrixWorld(true);
        
        // Check if each corner contains geometry using raycasting
        let cornerStatus = { SW: false, SE: false, NW: false, NE: false };
        
        Object.keys(corners).forEach(cornerName => {
            const corner = corners[cornerName];
            
            // Test multiple points within the corner region
            const testPoints = [
                { x: corner.minX + 0.1, z: corner.minZ + 0.1 },
                { x: corner.maxX - 0.1, z: corner.minZ + 0.1 },
                { x: corner.minX + 0.1, z: corner.maxZ - 0.1 },
                { x: corner.maxX - 0.1, z: corner.maxZ - 0.1 },
                { x: (corner.minX + corner.maxX) / 2, z: (corner.minZ + corner.maxZ) / 2 }
            ];
            
            // Cast rays downward to check for geometry
            for (const point of testPoints) {
                raycaster.set(
                    new THREE.Vector3(point.x, sInfo.baseY + 2, point.z),
                    new THREE.Vector3(0, -1, 0)
                );
                
                const intersects = raycaster.intersectObject(obj, true);
                
                // Check if any intersection is near the base level
                for (const hit of intersects) {
                    if (Math.abs(hit.point.y - sInfo.baseY) < yTolerance) {
                        cornerStatus[cornerName] = true;
                        break;
                    }
                }
                
                if (cornerStatus[cornerName]) break;
            }
        });
        
        console.log(`Rotation ${i * 90}°: SW=${cornerStatus.SW ? '■' : '□'}, SE=${cornerStatus.SE ? '■' : '□'}, NW=${cornerStatus.NW ? '■' : '□'}, NE=${cornerStatus.NE ? '■' : '□'}`);
        
        // Best orientation is the one with SW corner empty and others filled
        if (!cornerStatus.SW && (cornerStatus.SE || cornerStatus.NW || cornerStatus.NE)) {
            bestOrientation = i;
            bestEmptySW = true;
            break; // Found ideal orientation
        }
    }
    
    // Apply the best orientation
    const finalRotation = baseRotation + (bestOrientation * Math.PI / 2);
    obj.rotation.y = finalRotation;
    obj.updateMatrixWorld(true);
    
    console.log(`Selected orientation: ${bestOrientation * 90}° rotation (SW corner ${bestEmptySW ? 'empty' : 'not ideal'})`);
    
    // Add a temporary visual indicator for the SW corner (at max X, max Z)
    const swIndicator = new THREE.Mesh(
        new THREE.BoxGeometry(1, 1, 1),
        new THREE.MeshBasicMaterial({ color: 0xffff00, transparent: true, opacity: 0.3 })
    );
    swIndicator.position.set(
        sInfo.rMaxX + 0.5,
        sInfo.baseY,
        sInfo.rMaxZ + 0.5
    );
    swIndicator.name = 'swCornerIndicator';
    scene.add(swIndicator);
    
    // Remove the SW indicator after 5 seconds
    setTimeout(() => {
        const indicator = scene.getObjectByName('swCornerIndicator');
        if (indicator) scene.remove(indicator);
    }, 5000);
    
    // Adjust Y position to rest on structure base
    obj.updateMatrixWorld(true);
    const adjustedBox = new THREE.Box3().setFromObject(obj);
    
    console.log('Y-position debug:', {
        structureBaseY: sInfo.baseY,
        modelBottomY: adjustedBox.min.y,
        voxelSize: voxelSize,
        originalY: originalPosition.y
    });
    
    // The model bottom should align with the structure base
    // Since voxels are centered at integer positions, and voxelSize is 1,
    // the bottom of a voxel at position Y is at Y - 0.5
    const targetY = sInfo.baseY - voxelSize / 2;  // Bottom face of the base voxel
    const currentModelBottom = adjustedBox.min.y;
    const offsetY = targetY - currentModelBottom;
    
    obj.position.y = originalPosition.y + offsetY;
    
    obj.updateMatrixWorld(true);
    
    console.log('Final transform:', {
        rotation: obj.rotation.y * 180 / Math.PI,
        scale: obj.scale.x,
        position: obj.position
    });
    
    showToast('Model aligned to structure', 'success');
}

// Removed helper functions - no longer needed with bounding box approach