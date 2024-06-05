import express from "express";
import Factura from "../models/Factura.js";
import { openingHours } from "../middleware/middleware.js";
import codFactura from "../models/codigoFactura.js";
import clientes from "../models/clientes.js";
import Cupones from "../models/cupones.js";
import Negocio from "../models/negocio.js";
import db from "../config/db.js";
import moment from "moment";
import Almacen from "../models/almacen.js";
import Anular from "../models/anular.js";
import Donacion from "../models/donacion.js";

import Servicio from "../models/portafolio/servicios.js";
import Producto from "../models/portafolio/productos.js";

import Pagos from "../models/pagos.js";

import { handleGetInfoDelivery, mapArrayByKey } from "../utils/utilsFuncion.js";
import { handleAddPago } from "./pagos.js";
import { handleAddGasto } from "./gastos.js";
import { handleGetInfoUser } from "./cuadreDiario.js";

const router = express.Router();

const createPuntosObj = (res, points) => {
  const {
    dateRecepcion: dateService,
    codRecibo: codigo,
    _id: idOrdenService,
    dni: dni,
    Nombre: nombre,
    direccion,
    celular: phone,
  } = res;

  const filter = {
    dni: dni,
  };

  const update = {
    $set: {
      nombre,
      phone,
      direccion,
    },
    $push: {
      infoScore: {
        idOrdenService,
        codigo,
        dateService,
        score: points,
      },
    },
    $inc: {
      scoreTotal: points,
    },
  };

  return { filter, update };
};

router.post("/add-factura", openingHours, async (req, res) => {
  const session = await db.startSession();
  session.startTransaction(); // Comienza una transacción

  try {
    const { infoOrden, infoPago } = req.body;
    const {
      codRecibo,
      dateRecepcion,
      Modalidad,
      Nombre,
      Items,
      celular,
      direccion,
      datePrevista,
      dateEntrega,
      descuento,
      estadoPrenda,
      estado,
      dni,
      subTotal,
      totalNeto,
      cargosExtras,
      factura,
      modeRegistro,
      modoDescuento,
      gift_promo,
      attendedBy,
      lastEdit,
      typeRegistro,
    } = infoOrden;

    // Consultar el último registro ordenado por el campo 'index' de forma descendente
    const ultimoRegistro = await Factura.findOne({}, { index: 1, _id: 0 })
      .sort({ index: -1 })
      .lean();

    // Obtener el último índice utilizado o establecer 0 si no hay registros
    const ultimoIndice = ultimoRegistro ? ultimoRegistro.index : 0;

    // Crear el nuevo índice incrementando el último índice en 1
    const nuevoIndice = ultimoIndice + 1;

    const dateCreation = {
      fecha: moment().format("YYYY-MM-DD"),
      hora: moment().format("HH:mm"),
    };

    let nCodigo;
    if (modeRegistro === "nuevo") {
      const codigoActual = await codFactura.findOne().sort({ _id: -1 }).lean();
      nCodigo = codigoActual.codActual;
    } else {
      nCodigo = codRecibo;
    }

    // Crear el nuevo registro con el índice asignado
    const nuevoDato = new Factura({
      codRecibo: nCodigo,
      dateCreation,
      dateRecepcion,
      Modalidad,
      Nombre,
      Items,
      celular,
      direccion,
      datePrevista,
      dateEntrega,
      descuento,
      estadoPrenda,
      estado,
      listPago: [],
      index: nuevoIndice,
      dni,
      subTotal,
      totalNeto,
      cargosExtras,
      factura,
      modeRegistro,
      notas: [],
      modoDescuento,
      gift_promo,
      location: 1,
      attendedBy,
      lastEdit,
      typeRegistro,
    });

    // Guardar el nuevo registro en la base de datos
    const fSaved = await nuevoDato.save({ session });

    let updatedCod;
    if (modeRegistro === "nuevo") {
      // Incrementa el valor de codActual en 1 y devuelve el documento actualizado
      updatedCod = await codFactura.findOneAndUpdate(
        {},
        { $inc: { codActual: 1 } },
        { new: true, session }
      );

      // Si el valor de codActual supera el valor de codFinal, reinicia codActual a 1
      if (updatedCod && updatedCod.codActual > updatedCod.codFinal) {
        updatedCod.codActual = 1;
        await updatedCod.save({ session });
      }

      // Si no se encuentra el documento actualizado, devuelve un error
      if (!updatedCod) {
        return res
          .status(404)
          .json({ mensaje: "Código de factura no encontrado" });
      }
    }

    let facturaGuardada = fSaved.toObject();

    let iGasto;
    if (infoOrden.Modalidad === "Delivery") {
      if (req.body.hasOwnProperty("infoGastoByDelivery")) {
        const { infoGastoByDelivery } = req.body;
        if (Object.keys(infoGastoByDelivery).length) {
          iGasto = await handleAddGasto(infoGastoByDelivery);
        }
      }
    }

    if (facturaGuardada.gift_promo.length > 0) {
      for (const gift of facturaGuardada.gift_promo) {
        const { codigoPromocion, codigoCupon } = gift;

        const nuevoCupon = new Cupones({
          codigoPromocion,
          codigoCupon,
          estado: true,
          dateCreation: {
            fecha: moment().format("YYYY-MM-DD"),
            hora: moment().format("HH:mm"),
          },
          dateUse: {
            fecha: "",
            hora: "",
          },
        });

        await nuevoCupon.save({ session });
      }
    }

    const beneficios = facturaGuardada.cargosExtras.beneficios;
    if (
      facturaGuardada.modoDescuento === "Puntos" &&
      beneficios.puntos > 0 &&
      facturaGuardada.dni
    ) {
      const ordenUsada = await clientes.findOne({
        dni: facturaGuardada.dni,
        "infoScore.idOrdenService": facturaGuardada._id,
      });

      if (!ordenUsada) {
        const puntosToDeduct = createPuntosObj(
          facturaGuardada,
          -beneficios.puntos
        );
        const { filter, update } = puntosToDeduct;

        await clientes.updateOne(filter, update, {
          upsert: true,
          session,
        });
      }
    }

    if (
      facturaGuardada.modoDescuento === "Promocion" &&
      beneficios.promociones.length > 0
    ) {
      await Promise.all(
        beneficios.promociones.map(async (cup) => {
          const cupon = await Cupones.findOne({ codigoCupon: cup.codigoCupon });
          cupon.estado = false;
          cupon.dateUse.fecha = moment().format("YYYY-MM-DD");
          cupon.dateUse.hora = moment().format("HH:mm");
          await cupon.save({ session });
        })
      );
    }

    const lPagos = [];
    if (infoPago.length > 0) {
      await Promise.all(
        infoPago.map(async (pago) => {
          const newIPago = await handleAddPago({
            ...pago,
            idOrden: facturaGuardada._id,
          });
          lPagos.push(newIPago);
        })
      );
    }

    await session.commitTransaction();

    let infoPagos = [];
    const finalLPagos = [];
    if (lPagos.length > 0) {
      const idsPagos = lPagos.map((pago) => pago._id);

      // Actualizar la facturaGuardada con los nuevos ids de pago
      facturaGuardada = await Factura.findByIdAndUpdate(
        facturaGuardada._id, // El _id de la factura que deseas actualizar
        { $addToSet: { listPago: { $each: idsPagos } } }, // Agregar los nuevos ids de pago al campo listPago
        { new: true } // Opción new: true para obtener el documento actualizado
      ).lean();

      infoPagos = await Pagos.find({
        _id: { $in: facturaGuardada.listPago },
      }).lean();

      await Promise.all(
        lPagos.map(async (pago) => {
          const newInfoPago = {
            _id: pago._id,
            idUser: pago.idUser,
            orden: facturaGuardada.codRecibo,
            idOrden: pago.idOrden,
            date: pago.date,
            nombre: facturaGuardada.Nombre,
            total: pago.total,
            metodoPago: pago.metodoPago,
            Modalidad: facturaGuardada.Modalidad,
            isCounted: pago.isCounted,
          };
          finalLPagos.push(newInfoPago);
        })
      );
    }

    res.json({
      newOrder: {
        ...facturaGuardada,
        ListPago: infoPagos,
        donationDate: {
          fecha: "",
          hora: "",
        },
      },
      ...(finalLPagos.length > 0 && { listNewsPagos: finalLPagos }),
      ...(iGasto && { newGasto: iGasto }),
      ...(updatedCod && { newCodigo: updatedCod.codActual }),
    });
  } catch (error) {
    await session.abortTransaction();
    console.error("Error al guardar los datos:", error);
    res.status(500).json({ mensaje: "Error al guardar los datos" });
  } finally {
    session.endSession();
  }
});

router.get("/get-factura", (req, res) => {
  Factura.find()
    .then((facturas) => {
      res.json(facturas);
    })
    .catch((error) => {
      console.error("Error al obtener los datos:", error);
      res.status(500).json({ mensaje: "Error al obtener los datos" });
    });
});

router.get("/get-factura/:id", (req, res) => {
  const { id } = req.params; // Obteniendo el id desde los parámetros de la URL
  Factura.findById(id)
    .then((factura) => {
      if (factura) {
        res.json(factura);
      } else {
        res.status(404).json({ mensaje: "Factura no encontrada" });
      }
    })
    .catch((error) => {
      console.error("Error al obtener los datos:", error);
      res.status(500).json({ mensaje: "Error al obtener los datos" });
    });
});

router.get("/get-factura/date/:startDate/:endDate", async (req, res) => {
  const { startDate, endDate } = req.params;

  try {
    // Buscar todas las facturas dentro del rango de fechas
    const ordenes = await Factura.find({
      "dateRecepcion.fecha": {
        $gte: startDate,
        $lte: endDate,
      },
    }).lean();

    // Obtener todos los IDs de pagos y donaciones relevantes
    const idsPagos = ordenes.flatMap((orden) => orden.listPago);
    const idsDonaciones = ordenes.map((orden) => orden._id);

    // Consultar todos los pagos y donaciones relevantes
    const [pagos, donaciones] = await Promise.all([
      Pagos.find({ _id: { $in: idsPagos } }).lean(),
      Donacion.find({ serviceOrder: { $in: idsDonaciones } }).lean(),
    ]);

    // Crear un mapa de pagos por ID de orden para un acceso más rápido
    const pagosPorOrden = mapArrayByKey(pagos, "idOrden");

    // Procesar cada orden de factura
    const resultados = ordenes.map((orden) => ({
      ...orden,
      ListPago: pagosPorOrden[orden._id] || [],
      donationDate: donaciones.find((donado) =>
        donado.serviceOrder.includes(orden._id.toString())
      )?.donationDate || { fecha: "", hora: "" },
    }));

    res.status(200).json(resultados);
  } catch (error) {
    console.error("Error al obtener datos: ", error);
    res.status(500).json({ mensaje: "Error interno del servidor" });
  }
});

const generateDateArray = (type, filter) => {
  let fechas = [];

  if (type === "daily") {
    const { days } = filter;
    // Generar fechas para los próximos 3 días
    fechas = Array.from({ length: days }, (_, index) =>
      moment().startOf("day").add(index, "days").format("YYYY-MM-DD")
    );
    return fechas;
  } else {
    if (type === "monthly") {
      const { date } = filter;
      // Generar fechas para todo el mes
      const firstDayOfMonth = moment(date).startOf("month");
      const lastDayOfMonth = moment(date).endOf("month");

      let currentDate = moment(firstDayOfMonth);
      while (currentDate <= lastDayOfMonth) {
        fechas.push(currentDate.format("YYYY-MM-DD"));
        currentDate.add(1, "day");
      }
      return fechas;
    }
  }
};

router.post("/get-report/date-prevista/:type", async (req, res) => {
  try {
    const { type } = req.params;
    const filter = req.body;
    const datesArray = generateDateArray(type, filter);
    const infoReporte = [];

    const infoNegocio = await Negocio.findOne();
    const itemsReporte = infoNegocio.itemsInformeDiario;

    const infoDelivery = await handleGetInfoDelivery();

    itemsReporte.push({
      order: itemsReporte.length,
      id: `SER${infoDelivery._id.toString()}`,
    });

    const splitItem = itemsReporte.map((items) => {
      return {
        ID: items.id.substring(3),
        TIPO: items.id.substring(0, 3),
      };
    });

    let groupedResults = [];

    // Recorremos cada elemento de splitItem
    for (const item of splitItem) {
      try {
        let resultObject = {};
        resultObject.idColumna = item.ID;

        // Si los primeros caracteres son "CAT", busca en la colección categorias
        if (item.TIPO === "CAT") {
          const servicios = await Servicio.find(
            { idCategoria: item.ID },
            "_id"
          );
          const productos = await Producto.find(
            { idCategoria: item.ID },
            "_id"
          );

          const idsServicios = servicios.map((servicio) =>
            servicio._id.toString()
          );
          const idsProductos = productos.map((producto) =>
            producto._id.toString()
          );

          // Combinamos los IDs de servicios y productos
          resultObject.idsCantidades = [...idsServicios, ...idsProductos];
        } else {
          // Si no es "CAT", simplemente agregamos el ID al array
          resultObject.idsCantidades = [item.ID];
        }

        // Agregamos el objeto al array de resultados
        groupedResults.push(resultObject);
      } catch (error) {
        console.error("Error al buscar el documento:", error);
      }
    }

    for (const datePrevista of datesArray) {
      const facturas = await Factura.find({
        "datePrevista.fecha": datePrevista,
        estadoPrenda: { $nin: ["anulado", "donado"] },
      });

      const resultado = {
        FechaPrevista: datePrevista,
        CantidadPedido: facturas.length,
        InfoItems: {},
      };

      // Utiliza Promise.all para esperar a que se completen todas las operaciones asíncronas antes de continuar
      await Promise.all(
        facturas.map(async (factura) => {
          // Recorremos cada factura
          await Promise.all(
            factura.Items.map(async (order) => {
              // Recorremos cada item de la factura

              for (const item of groupedResults) {
                // Verificamos si el identificador está en los idsCantidades de cada grupo
                if (item.idsCantidades.includes(order.identificador)) {
                  // Verificar si resultado.InfoItems[item.idColumna] es un número
                  const existingValue =
                    parseFloat(resultado.InfoItems[item.idColumna]) || 0;
                  // Sumar el valor existente con la cantidad de la orden y formatearlo a 2 decimales
                  resultado.InfoItems[item.idColumna] = (
                    existingValue + Number(order.cantidad)
                  ).toFixed(2);
                }
              }
            })
          );
        })
      );

      resultado.InfoItems = Object.entries(resultado.InfoItems).map(
        ([identificador, Cantidad]) => ({
          identificador,
          Cantidad,
        })
      );

      groupedResults.forEach((group) => {
        // Verifica si la idColumna ya existe en resultado.InfoItems
        const existingItem = resultado.InfoItems.find(
          (item) => item.identificador === group.idColumna
        );

        if (!existingItem) {
          // Si la idColumna no existe, agrega una nueva entrada con cantidad 0
          resultado.InfoItems.push({
            identificador: group.idColumna,
            Cantidad: 0,
          });
        }
      });

      infoReporte.push(resultado);
    }

    res.json(infoReporte);
  } catch (error) {
    console.error("Error al obtener los datos:", error);
    res.status(500).json({ mensaje: "Error al obtener los datos" });
  }
});

router.put("/update-factura/:id", openingHours, async (req, res) => {
  const session = await db.startSession();
  session.startTransaction(); // Comienza una transacción

  try {
    const facturaId = req.params.id;
    const { infoOrden } = req.body;

    Factura.findById(facturaId)
      .then((factura) => {
        if (!factura) {
          return res.status(404).json({ mensaje: "Factura no encontrada" });
        }

        const orderInicial = factura;

        // Crea un objeto con los campos y valores actualizados
        const orderToUpdate = {};

        // Itera a través de los campos existentes en la factura y actualiza si se proporcionan en req.body
        for (const field in orderInicial.toObject()) {
          if (infoOrden.hasOwnProperty(field)) {
            orderToUpdate[field] = infoOrden[field];
          } else {
            orderToUpdate[field] = infoOrden[field];
          }
        }

        // Actualiza los campos en la base de datos
        Factura.findOneAndUpdate(
          { _id: facturaId },
          { $set: orderToUpdate },
          { new: true, session: session }
        )
          .then(async (uOrder) => {
            const orderUpdated = uOrder.toObject();

            const lPagos = [];
            if (orderInicial.estado === "reservado") {
              const { infoPago } = req.body;
              if (infoPago.length > 0) {
                await Promise.all(
                  infoPago.map(async (pago) => {
                    const newIPago = await handleAddPago({
                      ...pago,
                      idOrden: orderInicial._id,
                    });

                    lPagos.push(newIPago);
                  })
                );
              }
            }

            let iGasto;
            // Verificar si la modalidad es "Delivery" y "Entrgado"
            if (
              orderUpdated.Modalidad === "Delivery" &&
              orderUpdated.estadoPrenda === "entregado"
            ) {
              if (req.body.hasOwnProperty("infoGastoByDelivery")) {
                const { infoGastoByDelivery } = req.body;
                if (Object.keys(infoGastoByDelivery).length) {
                  iGasto = await handleAddGasto(infoGastoByDelivery);
                }
              }
            }

            // let newAnulacion;
            if (orderUpdated.estadoPrenda === "anulado") {
              const { infoAnulacion } = req.body;

              const nuevaAnulacion = new Anular(infoAnulacion);

              await nuevaAnulacion
                .save({ session: session })
                .then(async (anulado) => {
                  // newAnulacion = anulado;

                  if (orderUpdated.dni) {
                    // una vez anulado - eliminar puntaje de orden de servicio
                    const idOrderEliminada = anulado._id;

                    const cliente = await clientes.findOne({
                      dni: orderUpdated.dni,
                    });

                    if (cliente) {
                      cliente.infoScore = cliente.infoScore.filter(
                        (info) => info.idOrdenService !== idOrderEliminada
                      );

                      cliente.scoreTotal = cliente.infoScore
                        .reduce(
                          (total, info) => total + parseInt(info.score, 10),
                          0
                        )
                        .toString();
                      await cliente.save({ session: session });
                    }
                  }
                })
                .catch((error) => {
                  console.error("Error al anular cliente:", error);
                  res.status(500).json({ mensaje: "Error al anular cliente:" });
                });
            }

            if (
              orderUpdated.estadoPrenda === "pendiente" &&
              orderUpdated.Modalidad === "Delivery" &&
              orderToUpdate.modeRegistro !== "antiguo"
            ) {
              // Asegurar que se Registren las promociones como (cupones)
              if (orderUpdated.gift_promo.length > 0) {
                const ListPromos = orderUpdated.gift_promo;
                await Promise.all(
                  ListPromos.map(async (promo) => {
                    const codigoCupon = promo.codigoCupon;
                    const exist = await Cupones.findOne({ codigoCupon });

                    if (!exist) {
                      const codigoPromocion = promo.codigoPromocion;
                      // Crear el nuevo cupón en la base de datos
                      const nuevoCupon = new Cupones({
                        codigoPromocion,
                        codigoCupon,
                        estado: true, // Por defecto, el estado es true
                        dateCreation: {
                          fecha: moment().format("YYYY-MM-DD"),
                          hora: moment().format("HH:mm"),
                        },
                        dateUse: {
                          fecha: "",
                          hora: "",
                        },
                      });

                      await nuevoCupon.save({ session: session });
                    }
                  })
                );
              }

              const beneficios = orderUpdated.cargosExtras.beneficios;
              if (
                orderUpdated.modoDescuento === "Puntos" &&
                beneficios.puntos > 0 &&
                orderUpdated.dni !== ""
              ) {
                // Si la orden esta estan usado en cliento osea registrado
                const ordenUsada = await clientes.findOne({
                  dni: orderUpdated.dni,
                  "infoScore.idOrdenService": orderUpdated._id,
                });

                // si no a sido registrado  pues aplicar puntos
                if (!ordenUsada) {
                  const puntosToDeduct = createPuntosObj(
                    orderUpdated,
                    -beneficios.puntos
                  ); // reducir puntos a erse cliente
                  const { filter, update } = puntosToDeduct;
                  await clientes.updateOne(filter, update, {
                    upsert: true,
                    session: session,
                  });
                }
              }

              // Asegurar que los Cupones se usen
              if (
                orderUpdated.modoDescuento === "Promocion" &&
                beneficios.promociones.length > 0
              ) {
                const ListPromos = beneficios.promociones;
                await Promise.all(
                  ListPromos.map(async (promo) => {
                    const codigoCupon = promo.codigoCupon;
                    const cupon = await Cupones.findOne({ codigoCupon });

                    if (cupon.estado === true) {
                      cupon.estado = false;

                      // Registrar la fecha y hora actual en el campo dateUse
                      (cupon.dateUse.fecha = moment().format("YYYY-MM-DD")),
                        (cupon.dateUse.hora = moment().format("HH:mm")),
                        // Guardar los cambios en la base de datos
                        await cupon.save({ session: session });
                    }
                  })
                );
              }
            }

            if (
              orderUpdated.estadoPrenda === "entregado" &&
              orderUpdated.dni !== ""
            ) {
              const score = parseInt(orderUpdated.totalNeto);
              const puntosObj = createPuntosObj(orderUpdated, score);
              const { filter, update } = puntosObj;
              await clientes.updateOne(filter, update, {
                upsert: true,
                session: session,
              });
            }

            if (orderUpdated.location === 1 && orderInicial.location === 2) {
              await Almacen.updateMany(
                { serviceOrder: orderUpdated._id },
                { $pull: { serviceOrder: orderUpdated._id } },
                { session: session }
              );
            }

            await session.commitTransaction();

            const infoPagos = await Pagos.find({
              _id: { $in: orderUpdated.listPago },
            }).lean();

            const finalLPagos = [];
            if (lPagos.length > 0) {
              await Promise.all(
                lPagos.map(async (pago) => {
                  finalLPagos.push({
                    _id: pago._id,
                    idUser: pago.idUser,
                    orden: orderUpdated.codRecibo,
                    idOrden: pago.idOrden,
                    date: pago.date,
                    nombre: orderUpdated.Nombre,
                    total: pago.total,
                    metodoPago: pago.metodoPago,
                    Modalidad: orderUpdated.Modalidad,
                    isCounted: pago.isCounted,
                    infoUser: await handleGetInfoUser(pago.idUser),
                  });
                })
              );
            }

            res.json({
              orderUpdated: {
                ...orderUpdated,
                ListPago: infoPagos,
                donationDate: {
                  fecha: "",
                  hora: "",
                },
              },
              ...(finalLPagos.length > 0 && { listNewsPagos: finalLPagos }),
              ...(iGasto && { newGasto: iGasto }),
            });
          })
          .catch((error) => {
            console.error("Error al actualizar la factura:", error);
            res.status(500).json({ mensaje: "Error al actualizar la factura" });
          });
      })
      .catch((error) => {
        console.error("Error Ordern no Encontrada:", error);
        res.status(500).json({ mensaje: "Error Ordern no Encontrada" });
      });
  } catch (error) {
    await session.abortTransaction();
    console.error("Error al actualizar los datos de la orden:", error);
    res
      .status(500)
      .json({ mensaje: "Error al actualizar los datos de la orden" });
  }
});

router.post("/cancel-entrega/:idOrden", async (req, res) => {
  const session = await db.startSession();
  session.startTransaction(); // Comienza una transacción

  try {
    const facturaId = req.params.idOrden;

    // Obtener factura por ID
    const factura = await Factura.findById(facturaId);
    if (!factura) {
      return res.status(404).json({ error: "Factura no encontrada" });
    }

    const fechaActual = moment().format("YYYY-MM-DD");
    if (
      factura.estadoPrenda === "entregado" &&
      factura.dateEntrega.fecha === fechaActual
    ) {
      // Actualizar cliente si tiene DNI
      if (factura.dni !== "") {
        const cliente = await clientes
          .findOne({ dni: factura.dni })
          .session(session);
        if (cliente) {
          // Actualizar cliente y sus infoScore
          const facturaIdString = factura._id.toString();

          const updatedInfoScore = cliente.infoScore.filter(
            (score) => score.idOrdenService !== facturaIdString
          );

          // Actualizar el scoreTotal del cliente
          cliente.infoScore = updatedInfoScore;
          cliente.scoreTotal = cliente.infoScore.reduce(
            (total, score) => total + parseInt(score.score),
            0
          );

          await cliente.save({ session: session });
        }
      }

      let orderUpdate = await Factura.findOneAndUpdate(
        { _id: facturaId },
        {
          estadoPrenda: "pendiente",
          dateEntrega: {
            fecha: "",
            hora: "",
          },
        },
        { new: true, session: session }
      );

      await session.commitTransaction();

      orderUpdate = orderUpdate.toObject();
      const infoPagos = await Pagos.find({
        _id: { $in: orderUpdate.listPago },
      }).lean();

      res.json({
        ...orderUpdate,
        ListPago: infoPagos,
        donationDate: {
          fecha: "",
          hora: "",
        },
      });
    } else {
      res.status(404).json({
        mensaje: "No cumple con los parametros para cancelar entrega",
      });
    }
  } catch (error) {
    await session.abortTransaction();
    console.error(error);
    res.status(500).json({ mensaje: "Error al cancelar Entrega" });
  }
});

export default router;
