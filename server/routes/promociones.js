import express from "express";
import Promociones from "../models/promociones.js";
import Cupones from "../models/cupones.js";

const router = express.Router();

router.delete("/eliminar-promocion/:id", async (req, res) => {
  try {
    const { id } = req.params;

    // Elimina la promoción y captura su `_id` y `codigo`
    const promocion = await Promociones.findByIdAndDelete(id);

    if (!promocion) {
      return res.status(404).json({ mensaje: "Promoción no encontrada" });
    }

    // Elimina los cupones relacionados
    await Cupones.deleteMany({ codigoPromocion: promocion.codigo });

    res.status(201).json({
      onAction: "add",
      info: promocion,
    });
  } catch (error) {
    console.error("Error al eliminar la promoción:", error);
    res.status(500).json({ mensaje: "Error al eliminar la promoción" });
  }
});

router.post("/add-promocion", async (req, res) => {
  try {
    const {
      prenda,
      cantidadMin,
      alcance,
      tipoDescuento,
      tipoPromocion,
      descripcion,
      descuento,
      vigencia,
      state,
    } = req.body;

    if (
      (prenda.length === 0 && alcance === "Parte") ||
      !tipoDescuento ||
      !tipoPromocion ||
      !alcance ||
      !descripcion ||
      !descuento ||
      !vigencia ||
      !state
    ) {
      return res
        .status(400)
        .json({ mensaje: "Todos los campos son requeridos." });
    }

    const codigoPromocion = await generarCodigoPromocionUnico();

    const nuevaPromoción = new Promociones({
      codigo: codigoPromocion,
      prenda,
      cantidadMin,
      tipoDescuento,
      alcance,
      tipoPromocion,
      descripcion,
      descuento,
      vigencia,
      state,
    });

    const promociónGuardada = await nuevaPromoción.save();
    res.status(201).json({
      onAction: "add",
      info: promociónGuardada,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ mensaje: "Error al guardar promoción" });
  }
});

router.put("/update-promocion/:id", async (req, res) => {
  try {
    const promocionId = req.params.id;
    const newInfoPromo = req.body;

    // Comprueba si los datos a actualizar existen en el cuerpo de la solicitud
    if (!req.body || Object.keys(newInfoPromo).length === 0) {
      return res
        .status(400)
        .json({ mensaje: "Los datos de actualización son requeridos" });
    }

    const promocionActualizada = await Promociones.findByIdAndUpdate(
      promocionId,
      newInfoPromo,
      { new: true }
    );

    if (!promocionActualizada) {
      return res.status(404).json({ mensaje: "Promoción no encontrada" });
    }

    res.status(200).json({
      onAction: "update",
      info: promocionActualizada,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ mensaje: "Error al actualizar promoción" });
  }
});

async function generarCodigoPromocionUnico() {
  let numero = 1;
  while (true) {
    const codigoPromocion = `PROM${numero.toString().padStart(4, "0")}`;
    const codigoDuplicado = await Promociones.findOne({
      codigo: codigoPromocion,
    });
    if (!codigoDuplicado) {
      return codigoPromocion;
    }
    numero++;
  }
}

router.get("/get-promociones", (req, res) => {
  Promociones.find()
    .then((promos) => {
      res.json(promos);
    })
    .catch((error) => {
      console.error("Error al obtener los datos:", error);
      res.status(500).json({ mensaje: "Error al obtener los datos" });
    });
});

export default router;
