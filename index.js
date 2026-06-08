// const Matter = require('matter-js');

function mulberry32(a) {
	return function() {
		let t = a += 0x6D2B79F5;
		t = Math.imul(t ^ t >>> 15, t | 1);
		t ^= t + Math.imul(t ^ t >>> 7, t | 61);
		return ((t ^ t >>> 14) >>> 0) / 4294967296;
	}
}

const rand = mulberry32(Date.now());

const {
	Engine, Render, Runner, Composites, Common, MouseConstraint, Mouse,
	Composite, Bodies, Events,
} = Matter;

// Trace the silhouette of an image by radial sampling from its center.
// Returns vertices relative to the image's center, in pixel units.
function extractHitboxVertices(img, numSamples = 28, alphaThreshold = 32) {
	const w = img.naturalWidth;
	const h = img.naturalHeight;
	const canvas = document.createElement('canvas');
	canvas.width = w;
	canvas.height = h;
	const ctx = canvas.getContext('2d');
	ctx.drawImage(img, 0, 0);
	const data = ctx.getImageData(0, 0, w, h).data;

	const cx = w / 2;
	const cy = h / 2;
	const maxR = Math.max(w, h) / 2 * 1.05;

	const vertices = [];
	for (let i = 0; i < numSamples; i++) {
		const angle = (Math.PI * 2 * i) / numSamples;
		const dx = Math.cos(angle);
		const dy = Math.sin(angle);

		let hitR = 0;
		const stepSize = Math.max(1, Math.floor(maxR / 256));
		for (let r = maxR; r > 0; r -= stepSize) {
			const px = Math.floor(cx + dx * r);
			const py = Math.floor(cy + dy * r);
			if (px < 0 || px >= w || py < 0 || py >= h) continue;
			const alphaIdx = (py * w + px) * 4 + 3;
			if (data[alphaIdx] > alphaThreshold) {
				hitR = r;
				break;
			}
		}

		if (hitR <= 0) hitR = maxR * 0.25;
		vertices.push({ x: dx * hitR, y: dy * hitR });
	}

	return vertices;
}

const wallPad = 64;
const loseHeight = 84;
const statusBarHeight = 48;
const previewBallHeight = 32;
const friction = {
	friction: 0.006,
	frictionStatic: 0.006,
	frictionAir: 0,
	restitution: 0.1
};

const GameStates = {
	MENU: 0,
	READY: 1,
	DROP: 2,
	LOSE: 3,
};

const Game = {
	width: 640,
	height: 960,
	elements: {
		canvas: document.getElementById('game-canvas'),
		ui: document.getElementById('game-ui'),
		score: document.getElementById('game-score'),
		end: document.getElementById('game-end-container'),
		endTitle: document.getElementById('game-end-title'),
		statusValue: document.getElementById('game-highscore-value'),
		nextFruitImg: document.getElementById('game-next-fruit'),
		winContainer: document.getElementById('game-win-container'),
		winContinue: document.getElementById('game-win-continue'),
		previewBall: null,
	},
	tier11Reached: false,
	cache: { highscore: 0 },
	sounds: {
		click: new Audio('./assets/click.mp3?v=2'),
		pop0: new Audio('./assets/pop0.mp3?v=2'),
		pop1: new Audio('./assets/pop1.mp3?v=2'),
		pop2: new Audio('./assets/pop2.mp3?v=2'),
		pop3: new Audio('./assets/pop3.mp3?v=2'),
		pop4: new Audio('./assets/pop4.mp3?v=2'),
		pop5: new Audio('./assets/pop5.mp3?v=2'),
		pop6: new Audio('./assets/pop6.mp3?v=2'),
		pop7: new Audio('./assets/pop7.mp3?v=2'),
		pop8: new Audio('./assets/pop8.mp3?v=2'),
		pop9: new Audio('./assets/pop9.mp3?v=2'),
		pop10: new Audio('./assets/pop10.mp3?v=2'),
	},

	stateIndex: GameStates.MENU,

	score: 0,
	fruitsMerged: [],
	calculateScore: function () {
		const score = Game.fruitsMerged.reduce((total, count, sizeIndex) => {
			const value = Game.fruitSizes[sizeIndex].scoreValue * count;
			return total + value;
		}, 0);

		Game.score = score;
		Game.elements.score.innerText = Game.score;
	},

	fruitSizes: [
		{ radius: 24,  scoreValue: 1,  img: './assets/img/circle0.png'  },
		{ radius: 32,  scoreValue: 3,  img: './assets/img/circle1.png'  },
		{ radius: 40,  scoreValue: 6,  img: './assets/img/circle2.png'  },
		{ radius: 56,  scoreValue: 10, img: './assets/img/circle3.png'  },
		{ radius: 64,  scoreValue: 15, img: './assets/img/circle4.png'  },
		{ radius: 72,  scoreValue: 21, img: './assets/img/circle5.png'  },
		{ radius: 84,  scoreValue: 28, img: './assets/img/circle6.png'  },
		{ radius: 96,  scoreValue: 36, img: './assets/img/circle7.png'  },
		{ radius: 128, scoreValue: 45, img: './assets/img/circle8.png'  },
		{ radius: 160, scoreValue: 55, img: './assets/img/circle9.png'  },
		{ radius: 192, scoreValue: 66, img: './assets/img/circle10.png' },
	],

	menuChrome: {
		bgMenu:   { img: './assets/img/bg-menu.png',   targetW: 512, targetH: 512, imgWidth: 512, imgHeight: 512 },
		btnStart: { img: './assets/img/btn-start.png', targetW: 512, targetH: 96,  imgWidth: 512, imgHeight: 96  },
	},

	preloadMenuChrome: function () {
		return Promise.all(Object.values(Game.menuChrome).map((item) => new Promise((resolve) => {
			const img = new Image();
			img.onload = () => {
				item.imgWidth = img.naturalWidth;
				item.imgHeight = img.naturalHeight;
				resolve();
			};
			img.onerror = () => resolve();
			img.src = item.img;
		})));
	},

	preloadFruitImages: function () {
		return Promise.all(Game.fruitSizes.map((size) => new Promise((resolve) => {
			const img = new Image();
			img.onload = () => {
				size.imgWidth = img.naturalWidth;
				size.imgHeight = img.naturalHeight;
				try {
					const verts = extractHitboxVertices(img);
					let maxDist = 0;
					for (const v of verts) {
						const d = Math.sqrt(v.x * v.x + v.y * v.y);
						if (d > maxDist) maxDist = d;
					}
					size.outlineVerts = verts;
					size.outlineMaxDist = maxDist;
				} catch (err) {
					console.warn('Outline extraction failed for', size.img, err);
					size.outlineVerts = null;
					size.outlineMaxDist = 0;
				}
				resolve();
			};
			img.onerror = () => {
				size.imgWidth = 1024;
				size.imgHeight = 1024;
				size.outlineVerts = null;
				size.outlineMaxDist = 0;
				resolve();
			};
			img.crossOrigin = 'anonymous';
			img.src = size.img;
		})));
	},
	currentFruitSize: 0,
	nextFruitSize: 0,
	setNextFruitSize: function () {
		Game.nextFruitSize = Math.floor(rand() * 5);
		Game.elements.nextFruitImg.src = `./assets/img/circle${Game.nextFruitSize}.png`;
	},

	showHighscore: function () {
		Game.elements.statusValue.innerText = Game.cache.highscore;
	},
	loadHighscore: function () {
		const gameCache = localStorage.getItem('suika-game-cache');
		if (gameCache === null) {
			Game.saveHighscore();
			return;
		}

		Game.cache = JSON.parse(gameCache);
		Game.showHighscore();
	},
	saveHighscore: function () {
		Game.calculateScore();
		if (Game.score < Game.cache.highscore) return;

		Game.cache.highscore = Game.score;
		Game.showHighscore();
		Game.elements.endTitle.innerText = 'New Highscore!';

		localStorage.setItem('suika-game-cache', JSON.stringify(Game.cache));
	},

	initGame: function () {
		Render.run(render);
		Runner.run(runner, engine);

		Composite.add(engine.world, menuStatics);

		Game.loadHighscore();
		Game.elements.ui.style.display = 'none';
		Game.fruitsMerged = Array.apply(null, Array(Game.fruitSizes.length)).map(() => 0);

		const menuMouseDown = function () {
			if (mouseConstraint.body === null || mouseConstraint.body?.label !== 'btn-start') {
				return;
			}

			Events.off(mouseConstraint, 'mousedown', menuMouseDown);
			Game.startGame();
		}

		Events.on(mouseConstraint, 'mousedown', menuMouseDown);

		Game.elements.winContinue.addEventListener('click', () => {
			Game.hideWinPopup();
		});
	},

	startGame: function () {
		Game.sounds.click.play();

		Composite.remove(engine.world, menuStatics);
		Composite.add(engine.world, gameStatics);

		Game.calculateScore();
		Game.elements.endTitle.innerText = 'Game Over!';
		Game.elements.ui.style.display = 'block';
		Game.elements.end.style.display = 'none';
		Game.elements.previewBall = Game.generateFruitBody(Game.width / 2, previewBallHeight, 0, { isStatic: true });
		Composite.add(engine.world, Game.elements.previewBall);

		setTimeout(() => {
			Game.stateIndex = GameStates.READY;
		}, 250);

		Events.on(mouseConstraint, 'mouseup', function (e) {
			Game.addFruit(e.mouse.position.x);
		});

		Events.on(mouseConstraint, 'mousemove', function (e) {
			if (Game.stateIndex !== GameStates.READY) return;
			if (Game.elements.previewBall === null) return;

			Game.elements.previewBall.position.x = e.mouse.position.x;
		});

		Events.on(engine, 'collisionStart', function (e) {
			for (let i = 0; i < e.pairs.length; i++) {
				const { bodyA, bodyB } = e.pairs[i];

				// Skip if collision is wall
				if (bodyA.isStatic || bodyB.isStatic) continue;

				const aY = bodyA.position.y + bodyA.circleRadius;
				const bY = bodyB.position.y + bodyB.circleRadius;

				// Uh oh, too high!
				if (aY < loseHeight || bY < loseHeight) {
					Game.loseGame();
					return;
				}

				// Skip different sizes
				if (bodyA.sizeIndex !== bodyB.sizeIndex) continue;

				// Skip if already popped
				if (bodyA.popped || bodyB.popped) continue;

				let newSize = bodyA.sizeIndex + 1;

				// Go back to smallest size
				if (bodyA.circleRadius >= Game.fruitSizes[Game.fruitSizes.length - 1].radius) {
					newSize = 0;
				}

				Game.fruitsMerged[bodyA.sizeIndex] += 1;

				// Therefore, circles are same size, so merge them.
				const midPosX = (bodyA.position.x + bodyB.position.x) / 2;
				const midPosY = (bodyA.position.y + bodyB.position.y) / 2;

				bodyA.popped = true;
				bodyB.popped = true;

				Game.sounds[`pop${bodyA.sizeIndex}`].play();
				Composite.remove(engine.world, [bodyA, bodyB]);
				Composite.add(engine.world, Game.generateFruitBody(midPosX, midPosY, newSize));
				Game.addPop(midPosX, midPosY, bodyA.circleRadius);
				Game.calculateScore();

				if (newSize === Game.fruitSizes.length - 1 && !Game.tier11Reached) {
					Game.tier11Reached = true;
					Game.showWinPopup();
				}
			}
		});
	},

	showWinPopup: function () {
		Game.elements.winContainer.style.display = 'flex';
		runner.enabled = false;
	},

	hideWinPopup: function () {
		Game.elements.winContainer.style.display = 'none';
		runner.enabled = true;
	},

	addPop: function (x, y, r) {
		const circle = Bodies.circle(x, y, r, {
			isStatic: true,
			collisionFilter: { mask: 0x0040 },
			angle: rand() * (Math.PI * 2),
			render: {
				sprite: {
					texture: './assets/img/pop.png',
					xScale: r / 384,
					yScale: r / 384,
				}
			},
		});

		Composite.add(engine.world, circle);
		setTimeout(() => {
			Composite.remove(engine.world, circle);
		}, 100);
	},

	loseGame: function () {
		Game.stateIndex = GameStates.LOSE;
		Game.elements.end.style.display = 'flex';
		runner.enabled = false;
		Game.saveHighscore();
	},

	// Returns an index, or null
	lookupFruitIndex: function (radius) {
		const sizeIndex = Game.fruitSizes.findIndex(size => size.radius == radius);
		if (sizeIndex === undefined) return null;
		if (sizeIndex === Game.fruitSizes.length - 1) return null;

		return sizeIndex;
	},

	generateFruitBody: function (x, y, sizeIndex, extraConfig = {}) {
		const size = Game.fruitSizes[sizeIndex];
		const w = size.imgWidth || 1024;
		const h = size.imgHeight || 1024;

		let body;
		if (size.outlineVerts && size.outlineMaxDist > 0) {
			const scale = size.radius / size.outlineMaxDist;
			const scaledVerts = size.outlineVerts.map((v) => ({ x: v.x * scale, y: v.y * scale }));
			body = Bodies.fromVertices(x, y, [scaledVerts], {
				...friction,
				...extraConfig,
				render: { sprite: { texture: size.img, xScale: scale, yScale: scale } },
			});
			if (!body) {
				const fallbackScale = (size.radius * 2) / Math.max(w, h);
				body = Bodies.circle(x, y, size.radius, {
					...friction,
					...extraConfig,
					render: { sprite: { texture: size.img, xScale: fallbackScale, yScale: fallbackScale } },
				});
			}
		} else {
			const scale = (size.radius * 2) / Math.max(w, h);
			body = Bodies.circle(x, y, size.radius, {
				...friction,
				...extraConfig,
				render: { sprite: { texture: size.img, xScale: scale, yScale: scale } },
			});
		}

		body.sizeIndex = sizeIndex;
		body.popped = false;
		if (body.circleRadius == null) body.circleRadius = size.radius;

		return body;
	},

	addFruit: function (x) {
		if (Game.stateIndex !== GameStates.READY) return;

		Game.sounds.click.play();

		Game.stateIndex = GameStates.DROP;
		const latestFruit = Game.generateFruitBody(x, previewBallHeight, Game.currentFruitSize);
		Composite.add(engine.world, latestFruit);

		Game.currentFruitSize = Game.nextFruitSize;
		Game.setNextFruitSize();
		Game.calculateScore();

		Composite.remove(engine.world, Game.elements.previewBall);
		Game.elements.previewBall = Game.generateFruitBody(render.mouse.position.x, previewBallHeight, Game.currentFruitSize, {
			isStatic: true,
			collisionFilter: { mask: 0x0040 }
		});

		setTimeout(() => {
			if (Game.stateIndex === GameStates.DROP) {
				Composite.add(engine.world, Game.elements.previewBall);
				Game.stateIndex = GameStates.READY;
			}
		}, 500);
	}
}

const engine = Engine.create();
const runner = Runner.create();
const render = Render.create({
	element: Game.elements.canvas,
	engine,
	options: {
		width: Game.width,
		height: Game.height,
		wireframes: false,
		background: '#ffdcae'
	}
});

let menuStatics;
const buildMenuStatics = () => [
	(() => {
		const c = Game.menuChrome.bgMenu;
		const scale = Math.min(c.targetW / c.imgWidth, c.targetH / c.imgHeight);
		return Bodies.rectangle(Game.width / 2, Game.height * 0.4, c.targetW, c.targetH, {
			isStatic: true,
			render: { sprite: { texture: c.img, xScale: scale, yScale: scale } },
		});
	})(),

	// Add each fruit in a circle
	...Array.apply(null, Array(Game.fruitSizes.length)).map((_, index) => {
		const x = (Game.width / 2) + 192 * Math.cos((Math.PI * 2 * index)/12);
		const y = (Game.height * 0.4) + 192 * Math.sin((Math.PI * 2 * index)/12);
		const r = 64;
		const size = Game.fruitSizes[index];
		const w = size.imgWidth || 1024;
		const h = size.imgHeight || 1024;

		if (size.outlineVerts && size.outlineMaxDist > 0) {
			const scale = r / size.outlineMaxDist;
			const scaledVerts = size.outlineVerts.map((v) => ({ x: v.x * scale, y: v.y * scale }));
			const polyBody = Bodies.fromVertices(x, y, [scaledVerts], {
				isStatic: true,
				render: {
					sprite: {
						texture: `./assets/img/circle${index}.png`,
						xScale: scale,
						yScale: scale,
					},
				},
			});
			if (polyBody) return polyBody;
		}

		const menuScale = (r * 2) / Math.max(w, h);
		return Bodies.circle(x, y, r, {
			isStatic: true,
			render: {
				sprite: {
					texture: `./assets/img/circle${index}.png`,
					xScale: menuScale,
					yScale: menuScale,
				},
			},
		});
	}),

	(() => {
		const c = Game.menuChrome.btnStart;
		const scale = Math.min(c.targetW / c.imgWidth, c.targetH / c.imgHeight);
		return Bodies.rectangle(Game.width / 2, Game.height * 0.75, c.targetW, c.targetH, {
			isStatic: true,
			label: 'btn-start',
			render: { sprite: { texture: c.img, xScale: scale, yScale: scale } },
		});
	})(),
];

const wallProps = {
	isStatic: true,
	render: { fillStyle: '#FFEEDB' },
	...friction,
};

const gameStatics = [
	// Left
	Bodies.rectangle(-(wallPad / 2), Game.height / 2, wallPad, Game.height, wallProps),

	// Right
	Bodies.rectangle(Game.width + (wallPad / 2), Game.height / 2, wallPad, Game.height, wallProps),

	// Bottom
	Bodies.rectangle(Game.width / 2, Game.height + (wallPad / 2) - statusBarHeight, Game.width, wallPad, wallProps),
];

// add mouse control
const mouse = Mouse.create(render.canvas);
const mouseConstraint = MouseConstraint.create(engine, {
	mouse: mouse,
	constraint: {
		stiffness: 0.2,
		render: {
			visible: false,
		},
	},
});
render.mouse = mouse;

Promise.all([Game.preloadFruitImages(), Game.preloadMenuChrome()]).then(() => {
	menuStatics = buildMenuStatics();
	Game.initGame();
});

const resizeCanvas = () => {
	const screenWidth = document.body.clientWidth;
	const screenHeight = document.body.clientHeight;

	let newWidth = Game.width;
	let newHeight = Game.height;
	let scaleUI = 1;

	if (screenWidth * 1.5 > screenHeight) {
		newHeight = Math.min(Game.height, screenHeight);
		newWidth = newHeight / 1.5;
		scaleUI = newHeight / Game.height;
	} else {
		newWidth = Math.min(Game.width, screenWidth);
		newHeight = newWidth * 1.5;
		scaleUI = newWidth / Game.width;
	}

	render.canvas.style.width = `${newWidth}px`;
	render.canvas.style.height = `${newHeight}px`;

	Game.elements.ui.style.width = `${Game.width}px`;
	Game.elements.ui.style.height = `${Game.height}px`;
	Game.elements.ui.style.transform = `scale(${scaleUI})`;
};

document.body.onload = resizeCanvas;
document.body.onresize = resizeCanvas;
